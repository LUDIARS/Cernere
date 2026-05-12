/**
 * Composite Auth WebSocket ハンドラ
 *
 * `/auth/composite-ws?ticket=<ticket>` に接続し、デバイスフィンガープリントと
 * 本人確認コードのやり取りを通じて認証を完了する。
 *
 * 流れ:
 *   1. upgrade 時に ticket を検証 → AuthSession 取得
 *   2. open で `{type: "state", state: "pending_device"}` を送信
 *   3. クライアント:
 *        - `{type: "device", payload: {machine,browser,geo}}`
 *        - `{type: "verify_code", code}`
 *        - `{type: "resend"}`
 *   4. サーバー:
 *        - `{type: "state", state, data?}`     (遷移通知)
 *        - `{type: "authenticated", authCode}` (完了通知)
 *        - `{type: "error", retryable, reason}`
 *        - `{type: "ping"/"pong", ts}`
 *
 * 1 チケット = 1 WS 接続が前提 (ただし切断→再接続は同一チケットで可)。
 */

import type uWS from "uWebSockets.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import {
  getAuthSession,
  updateAuthSession,
  deleteAuthSession,
  type AuthSession,
  type AuthSessionUser,
} from "../auth/auth-session.js";
import {
  checkDevice,
  verifyChallenge,
  resendChallengeCode,
  type DeviceFingerprint,
} from "../auth/identity-verification.js";
import { issueAuthCode as sharedIssueAuthCode } from "../auth/auth-code.js";
import { ensureUserProjectRow } from "../project/service.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { devError, devLog } from "../logging/dev-logger.js";

// ── uWS UserData ──────────────────────────────────────────

export interface CompositeWsUserData {
  ticket: string;
  userId: string;
  closed: boolean;
}

// ── メッセージ型 ──────────────────────────────────────────

type ClientMessage =
  | { type: "device"; payload?: DeviceFingerprint }
  | { type: "verify_code"; code: string }
  | { type: "resend" }
  | { type: "pong"; ts: number };

type ServerMessage =
  | { type: "state"; state: AuthSession["state"]; data?: Record<string, unknown> }
  | { type: "authenticated"; authCode: string }
  | { type: "error"; retryable: boolean; reason: string }
  | { type: "ping"; ts: number };

const PING_INTERVAL_MS = 30_000;

const pingTimers = new Map<string, ReturnType<typeof setInterval>>();

// ── 安全 send (close 後も落ちない) ───────────────────────

function send(ws: uWS.WebSocket<CompositeWsUserData>, msg: ServerMessage): void {
  let data: CompositeWsUserData | undefined;
  try { data = ws.getUserData(); } catch { return; }
  if (data.closed) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    data.closed = true;
  }
}

// ── ticket 認証 (upgrade 時) ──────────────────────────────

export async function resolveCompositeTicket(
  ticket: string | undefined,
): Promise<AuthSession | null> {
  if (!ticket) return null;
  const session = await getAuthSession(ticket);
  if (!session) return null;
  if (session.state === "expired") return null;
  return session;
}

// ── authCode 発行 (auth-code.ts に共通化) ────────────────

async function issueAuthCode(user: AuthSessionUser): Promise<string> {
  return sharedIssueAuthCode({
    userId: user.userId,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
  });
}

/**
 * 認証完了直後に呼ぶ. session.projectKey が判明している
 * (= project_credentials → composite WS 経由) 場合のみ
 * `project_data_<projectKey>` に user 行を確保する.
 *
 * 失敗してもログのみで握り潰す (本筋の認証成功は妨げない).
 */
async function ensureProjectRowFromSession(session: AuthSession): Promise<void> {
  if (!session.projectKey) return;
  try {
    await ensureUserProjectRow(session.user.userId, session.projectKey);
  } catch (err) {
    devError("composite-auth.ensureUserProjectRow.failed", err, {
      userId: session.user.userId,
      projectKey: session.projectKey,
    });
  }
}

// ── open ──────────────────────────────────────────────────

export async function handleCompositeAuthOpen(
  ws: uWS.WebSocket<CompositeWsUserData>,
): Promise<void> {
  const data = ws.getUserData();
  devLog("composite-ws.open", { ticket: data.ticket, userId: data.userId });
  const session = await getAuthSession(data.ticket);
  if (!session) {
    devLog("composite-ws.open.expired", { ticket: data.ticket });
    send(ws, { type: "error", retryable: false, reason: "session expired" });
    try { ws.end(4401, "session expired"); } catch { /* ignore */ }
    return;
  }

  devLog("composite-ws.open.state", { ticket: data.ticket, state: session.state });
  send(ws, { type: "state", state: session.state, data: stateExtras(session) });

  const timer = setInterval(() => {
    send(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
  }, PING_INTERVAL_MS);
  pingTimers.set(data.ticket, timer);
}

function stateExtras(session: AuthSession): Record<string, unknown> | undefined {
  if (session.state === "challenge_pending") {
    return {
      deviceToken: session.deviceToken,
      emailMasked: maskEmail(session.user.email),
    };
  }
  return undefined;
}

// ── message ──────────────────────────────────────────────

export async function handleCompositeAuthMessage(
  ws: uWS.WebSocket<CompositeWsUserData>,
  raw: ArrayBuffer,
): Promise<void> {
  // uWS は message handler が return すると raw ArrayBuffer を detach する。
  // await の後で参照すると "detached ArrayBuffer" になるため、最初に
  // 同期で文字列化しておく (Buffer.from は内部 copy)。
  const rawText = Buffer.from(raw).toString();

  const data = ws.getUserData();
  const session = await getAuthSession(data.ticket);
  if (!session) {
    send(ws, { type: "error", retryable: false, reason: "session expired" });
    try { ws.end(4401, "session expired"); } catch { /* ignore */ }
    return;
  }

  let msg: ClientMessage;
  try {
    msg = JSON.parse(rawText) as ClientMessage;
  } catch (err) {
    // 観測のため stdout に残す (ewatch が拾えるように [http-error] と同階層のタグで)。
    // raw text は先頭 200 文字までに切る (size DoS / PII 漏洩防御)。
    console.log(`[composite-error] ${JSON.stringify({
      ts: new Date().toISOString(),
      ticket: data.ticket,
      reason: "invalid JSON",
      parseError: err instanceof Error ? err.message : String(err),
      rawLen: rawText.length,
      rawPreview: rawText.slice(0, 200),
    })}`);
    send(ws, { type: "error", retryable: true, reason: "invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "pong":
      // 生存確認。state は不変。
      return;
    case "device":
      await handleDevice(ws, session, msg.payload);
      return;
    case "verify_code":
      await handleVerifyCode(ws, session, msg.code);
      return;
    case "resend":
      await handleResend(ws, session);
      return;
    default:
      send(ws, { type: "error", retryable: true, reason: "unknown message type" });
  }
}

// ── device: fingerprint 到着 ─────────────────────────────

async function handleDevice(
  ws: uWS.WebSocket<CompositeWsUserData>,
  session: AuthSession,
  fingerprint: DeviceFingerprint | undefined,
): Promise<void> {
  // 中身が空なら retry 指示 (machine + browser のいずれか必須)
  if (!fingerprint || (!fingerprint.machine && !fingerprint.browser)) {
    send(ws, {
      type: "error",
      retryable: true,
      reason: "fingerprint is empty — please retry",
    });
    return;
  }

  try {
    const check = await checkDevice(
      { id: session.user.userId, email: session.user.email },
      fingerprint,
      { ip: session.ip, userAgent: session.userAgent },
    );

    if (check.trusted) {
      const now = new Date();
      await db.update(schema.users)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(schema.users.id, session.user.userId));
      const authCode = await issueAuthCode(session.user);
      await ensureProjectRowFromSession(session);
      await updateAuthSession(session.ticket, {
        state: "authenticated",
        authCode,
      });
      send(ws, { type: "state", state: "authenticated" });
      send(ws, { type: "authenticated", authCode });
      try { ws.end(1000, "done"); } catch { /* ignore */ }
      return;
    }

    if (!check.deviceToken) {
      send(ws, { type: "error", retryable: true, reason: "device verification could not be initialized" });
      return;
    }

    await updateAuthSession(session.ticket, {
      state: "challenge_pending",
      deviceToken: check.deviceToken,
    });

    send(ws, {
      type: "state",
      state: "challenge_pending",
      data: {
        deviceToken: check.deviceToken,
        anomalies: check.anomalies,
        emailMasked: check.emailMasked,
        codeChannel: check.codeChannel,
        deviceLabel: check.label,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "device check failed";
    // 「メール送信失敗」など再試行で解決しないものは retryable=false 相当だが、
    // 呼び出し側でリトライ判断できるよう retryable=true で返し理由を明示する。
    devError("composite-auth.device.failed", err, { userId: session.user.userId });
    send(ws, { type: "error", retryable: true, reason });
    logAuthEvent({
      event: "user.device.challenge.failed",
      userId: session.user.userId,
      error: reason,
      ip: session.ip,
    });
  }
}

// ── verify_code: 本人確認コード検証 ──────────────────────

async function handleVerifyCode(
  ws: uWS.WebSocket<CompositeWsUserData>,
  session: AuthSession,
  code: string,
): Promise<void> {
  if (session.state !== "challenge_pending" || !session.deviceToken) {
    send(ws, { type: "error", retryable: false, reason: "no active challenge" });
    return;
  }
  if (!code || typeof code !== "string") {
    send(ws, { type: "error", retryable: true, reason: "code is required" });
    return;
  }

  const result = await verifyChallenge(session.deviceToken, code);
  if (!result.ok) {
    const reason = result.error ?? "verification failed";
    if (result.remainingAttempts !== undefined) {
      send(ws, {
        type: "state",
        state: "challenge_pending",
        data: { error: reason, remainingAttempts: result.remainingAttempts },
      });
      return;
    }
    // 試行上限超過 / 期限切れ
    await updateAuthSession(session.ticket, { state: "expired", lastError: reason });
    send(ws, { type: "error", retryable: false, reason });
    try { ws.end(4403, reason); } catch { /* ignore */ }
    return;
  }

  // 検証成功 → authCode 発行
  const now = new Date();
  await db.update(schema.users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, session.user.userId));
  const authCode = await issueAuthCode(session.user);
  await ensureProjectRowFromSession(session);
  await updateAuthSession(session.ticket, { state: "authenticated", authCode });
  logAuthEvent({
    event: "user.login",
    userId: session.user.userId,
    email: session.user.email ?? undefined,
    provider: "composite_device_verified",
    ip: session.ip,
    userAgent: session.userAgent,
  });

  send(ws, { type: "state", state: "authenticated" });
  send(ws, { type: "authenticated", authCode });
  try { ws.end(1000, "done"); } catch { /* ignore */ }
}

// ── resend: コード再送 ───────────────────────────────────

async function handleResend(
  ws: uWS.WebSocket<CompositeWsUserData>,
  session: AuthSession,
): Promise<void> {
  if (session.state !== "challenge_pending" || !session.deviceToken) {
    send(ws, { type: "error", retryable: false, reason: "no active challenge" });
    return;
  }
  try {
    const ok = await resendChallengeCode(session.deviceToken);
    if (!ok) {
      send(ws, { type: "error", retryable: false, reason: "challenge expired" });
      return;
    }
    send(ws, { type: "state", state: "challenge_pending", data: { resent: true } });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "resend failed";
    send(ws, { type: "error", retryable: true, reason });
  }
}

// ── close ────────────────────────────────────────────────

export function handleCompositeAuthClose(
  ws: uWS.WebSocket<CompositeWsUserData>,
): void {
  let data: CompositeWsUserData | undefined;
  try { data = ws.getUserData(); } catch { return; }
  data.closed = true;

  const timer = pingTimers.get(data.ticket);
  if (timer) {
    clearInterval(timer);
    pingTimers.delete(data.ticket);
  }

  // authenticated なチケットは authCode が回収済みなので削除してよい。
  // 失敗 / 切断時は TTL 10 分で自動クリーンアップさせるためここでは残す
  // (ただし expired / authenticated は即削除)。
  void (async () => {
    const session = await getAuthSession(data.ticket);
    if (!session) return;
    if (session.state === "authenticated" || session.state === "expired") {
      await deleteAuthSession(data.ticket);
    }
  })();
}

// ── utils ────────────────────────────────────────────────

function maskEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${head}***${tail}@${domain}`;
}
