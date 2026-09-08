/**
 * Device Credential の HTTP 経路
 * (spec/plan/passkey-default-authentication.md §10 / §11 / §12.1)
 *
 * - `session`   : Cookie の Device Credential で無操作ログイン + ローテーション
 * - `logout`    : 現在の端末だけ失効
 * - `list`      : 認証設定画面に出す端末セッション一覧
 * - revoke / revoke-all: REST は拒否。接続中 WS の action proof 付き操作を使う。
 *
 * silent login / rotation は POST 限定で、 Origin を完全一致リストで検証する
 * (§10.1)。 Cookie が SameSite=Strict でも、 許可 origin の XSS からの
 * 呼び出しまでは止められないため、 経路側でも絞る。
 */

import { config } from "../config.js";
import { assertDeviceOrigin } from "../auth/device-origin.js";
import { AppError } from "../error.js";
import { devLog } from "../logging/dev-logger.js";
import { checkRateLimit } from "../redis.js";
import { extractBearerToken, generateAccessToken, verifyToken } from "../auth/jwt.js";
import {
  buildDeviceCookie,
  clearDeviceCookie,
  readDeviceCookie,
} from "../auth/device-cookie.js";
import {
  listDeviceCredentials,
  resolveDeviceSession,
  revokeDeviceCredential,
  rotateDeviceSession,
} from "../auth/device-credential.js";

interface RouteResult {
  status: string;
  data: unknown;
  cookies?: string[];
}

export interface DeviceRequestCtx {
  cookieHeader: string;
  origin: string;
  hostname: string;
  rotationId: string;
  ip?: string;
}

export async function handleDeviceRoute(
  action: string,
  body: string,
  authHeader: string,
  ctx: DeviceRequestCtx,
): Promise<RouteResult> {
  devLog("device.route", { action, ip: ctx.ip });
  switch (action) {
    case "session":    return session(ctx);
    case "logout":     return logout(ctx);
    case "list":       return list(authHeader);
    case "revoke": case "revoke-all":
      throw AppError.forbidden("Use an authenticated device_session WebSocket command");
    default:
      throw AppError.notFound(`Unknown device action: ${action}`);
  }
}

async function requireUserId(authHeader: string): Promise<string> {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Unauthorized: missing bearer token");
  const payload = await verifyToken(token);
  if (!payload || typeof payload.sub !== "string") {
    throw AppError.unauthorized("Unauthorized: invalid token");
  }
  return payload.sub;
}

/** X-Cernere-Rotation-Id の形式。 last_rotation_id が UUID 列であることに対応する。 */
const ROTATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 無操作ログイン + ローテーション (§11)。
 *
 * 認証上の 401 が確定した場合だけ Cookie を消す。 409 (競合) と 5xx では消さない —
 * 消してしまうと、 先行 rotation の完了を待てば復帰できたはずのクライアントを
 * パスキー再認証へ落とすことになる。
 */
async function session(ctx: DeviceRequestCtx): Promise<RouteResult> {
  assertDeviceOrigin(ctx.origin);
  if (!config.deviceSessionsEnabled) throw AppError.serviceUnavailable("Device sessions are not enabled");
  await checkRateLimit(`device-session:${ctx.ip ?? "unknown"}`, 60, 60);
  if (!ctx.rotationId) {
    throw AppError.badRequest("X-Cernere-Rotation-Id header is required");
  }
  // last_rotation_id は UUID 列。 形式を境界で弾かないと、 任意のヘッダ文字列が
  // そのまま INSERT され Postgres の型エラーが 500 として公開経路に出る。
  if (!ROTATION_ID_RE.test(ctx.rotationId)) {
    throw AppError.badRequest("X-Cernere-Rotation-Id must be a UUID");
  }
  const token = readDeviceCookie(ctx.cookieHeader, ctx.hostname);

  try {
    const result = await rotateDeviceSession({ token, rotationId: ctx.rotationId });
    return {
      status: "200 OK",
      data: {
        // ロールは必ず DB の実値を載せる。 固定値にすると admin が silent login の
        // たびに一般ユーザーへ降格する。
        accessToken: await generateAccessToken(result.userId, result.role, result.authentication, { deviceId: result.deviceId, authEpoch: result.authEpoch }),
        deviceId: result.deviceId,
        expiresAt: result.expiresAt.toISOString(),
      },
      cookies: [buildDeviceCookie(result.token, ctx.hostname, result.expiresAt)],
    };
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 401 && shouldClearCookie(err.code)) {
      // Cookie を消して返すため、 ここだけ throw せず 401 応答を組み立てる。
      return {
        status: "401 Unauthorized",
        data: { error: err.message, code: err.code },
        cookies: [clearDeviceCookie(ctx.hostname)],
      };
    }
    throw err;
  }
}

/** Cookie 削除を伴う 401 か (§11.4)。 MISSING は元々無いので消す必要が無い。 */
function shouldClearCookie(code: string | undefined): boolean {
  return code === "DEVICE_CREDENTIAL_INVALID"
    || code === "DEVICE_CREDENTIAL_EXPIRED"
    || code === "DEVICE_CREDENTIAL_REVOKED"
    || code === "PASSKEY_REQUIRED";
}

/** 現在の端末だけ logout する (§12.1)。 passkey は維持する。 */
async function logout(ctx: DeviceRequestCtx): Promise<RouteResult> {
  assertDeviceOrigin(ctx.origin);
  const token = readDeviceCookie(ctx.cookieHeader, ctx.hostname);
  if (token) {
    // 呼び出し元の特定は読み取り専用で行う。 ここでローテーションを走らせると
    // 世代だけ進んで失効しない行が残り得るうえ、 rotation_id ヘッダ無しの logout が
    // 常に失敗して端末が失効されないままになる。
    const resolved = await resolveDeviceSession(token);
    if (resolved) {
      await revokeDeviceCredential({
        userId: resolved.userId,
        deviceId: resolved.deviceId,
        reason: "logout",
      });
    }
    // 特定できない Cookie は既に無効。 Cookie を消せば目的は達している。
  }
  return {
    status: "200 OK",
    data: { ok: true },
    cookies: [clearDeviceCookie(ctx.hostname)],
  };
}

async function list(authHeader: string): Promise<RouteResult> {
  const userId = await requireUserId(authHeader);
  const devices = await listDeviceCredentials(userId);
  return {
    status: "200 OK",
    data: {
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        clientKind: d.clientKind,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
      })),
    },
  };
}
