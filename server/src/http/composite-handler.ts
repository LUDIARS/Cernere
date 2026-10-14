/**
 * Composite Auth ハンドラ
 *
 * 他サービスに組み込む用の認証フロー。
 *
 * 資格情報検証後に auth_session (Redis, 10分 TTL) を作成し
 * `{ ticket, wsPath, wsUrl }` を返却。クライアントは WS 経由で fingerprint を
 * 送信し、本人確認フローを完結させる。詳細は `server/src/ws/composite-auth.ts`。
 */

import { retiredLoginError, retiredLoginResult } from "../auth/retired-login.js";
import { sendMfaChallengeCode, verifyMfaChallenge } from "../auth/mfa-challenge.js";
import { parseMfaInput, requireMfaMethod } from "../auth/mfa-contract.js";
import { createAuthSession } from "../auth/auth-session.js";
import type { AuthenticationEvidence } from "../lib/authentication-evidence.js";
import { compositeWsPath, compositeWsUrl } from "../auth/composite-ws-url.js";
import { config } from "../config.js";

interface RouteResult {
  status: string;
  data: unknown;
}

export interface CompositeCtx {
  ip?: string;
  userAgent?: string;
  /**
   * project_credentials 経由で送られてきたリクエストの場合、その projectKey.
   * 直接 REST `/api/auth/composite/...` の場合は undefined.
   * `ensureUserProjectRow` の呼び出し対象を決めるのに使う.
   */
  projectKey?: string;
}

export async function handleCompositeRoute(
  action: string,
  body: string,
  ctx: CompositeCtx = {},
): Promise<RouteResult> {
  const p = parseBody(body);
  switch (action) {
    // メール+パスワードの登録・ログインは廃止 (パスキーのみ)。
    case "login": case "register": return retiredLoginResult("password");
    case "mfa-verify": return compositeMfaVerify(p, ctx);
    case "mfa-send-code": return compositeMfaSendCode(p, ctx);
    default:
      return { status: "404 Not Found", data: { error: `Unknown composite action: ${action}` } };
  }
}

/** project WS から呼ばれる auth コマンド用のエントリポイント */
export async function executeCompositeAction(
  action: "login" | "register" | "mfa-verify" | "mfa-send-code",
  payload: Record<string, unknown>,
  ctx: CompositeCtx = {},
): Promise<unknown> {
  switch (action) {
    case "login": case "register": throw retiredLoginError();
    case "mfa-verify": return (await compositeMfaVerify(payload, ctx)).data;
    case "mfa-send-code": return (await compositeMfaSendCode(payload, ctx)).data;
  }
}

/** auth_session 作成時に projectKey を伝搬する共通ラッパ */
function sessionCtx(ctx: CompositeCtx): { ip?: string; userAgent?: string; projectKey?: string } {
  return { ip: ctx.ip, userAgent: ctx.userAgent, projectKey: ctx.projectKey };
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

/**
 * 資格情報検証に成功したユーザーを auth_session として保存し、
 * ticket + wsPath を返す。fingerprint と本人確認は WS で行う。
 */
async function openAuthSession(
  user: { id: string; displayName: string; email: string | null; role: string },
  ctx: CompositeCtx,
  authentication?: AuthenticationEvidence,
): Promise<RouteResult> {
  const session = await createAuthSession(
    {
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      authentication,
    },
    sessionCtx(ctx),
  );
  return {
    status: "200 OK",
    data: {
      deviceVerificationRequired: true,
      ticket: session.ticket,
      wsPath: compositeWsPath(session.ticket),
      // サービスの画面 (埋め込み SDK) が直接つなぐ公開 URL。 FRONTEND_URL が不正なら省く
      ...(() => {
        const wsUrl = compositeWsUrl(session.ticket, config.frontendUrl);
        return wsUrl ? { wsUrl } : {};
      })(),
    },
  };
}

async function compositeMfaVerify(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const { mfaToken, method, code } = parseMfaInput(p);
  return verifyMfaChallenge(mfaToken ?? "", requireMfaMethod(method), code ?? "",
    { purpose: "composite", projectKey: ctx.projectKey }, async (user, _tx, authentication) => openAuthSession(user, ctx, authentication));
}

async function compositeMfaSendCode(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const { mfaToken, method } = parseMfaInput(p);
  await sendMfaChallengeCode(mfaToken ?? "", requireMfaMethod(method), { purpose: "composite", projectKey: ctx.projectKey });
  return { status: "200 OK", data: { sent: true } };
}
