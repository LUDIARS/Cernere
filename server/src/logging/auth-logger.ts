/**
 * 認証イベントロガー
 *
 * ユーザー認証・プロジェクト認証のイベントをコンソールとファイルの
 * 両方に書き出す。構造化 JSON ログで後から機械的に集計可能。
 *
 * ファイル出力:
 *   logs/auth-YYYY-MM-DD.log  (日付ローテーション)
 *
 * 環境変数:
 *   LOG_DIR       ログディレクトリ (デフォルト: ./logs)
 *   LOG_AUTH_FILE ファイル出力を無効にする場合は "false"
 */

import fs from "node:fs";
import path from "node:path";

type AuthEventType =
  | "user.login"
  | "user.login.failed"
  | "user.register"
  | "user.oauth"
  | "user.oauth.failed"
  | "user.ws.connect"
  | "user.ws.disconnect"
  | "user.mfa.challenge"
  | "user.mfa.verified"
  | "project.login"
  | "project.login.failed"
  | "project.ws.connect"
  | "project.ws.disconnect"
  | "project.ws.rejected"
  | "user.device.trusted"
  | "user.device.challenge"
  | "user.device.challenge.resent"
  | "user.device.verify.success"
  | "user.device.verify.failed";

interface AuthEventBase {
  event: AuthEventType;
  /** 任意: ユーザーID (user.* イベント) */
  userId?: string;
  /** 任意: メール (user.login 系) */
  email?: string;
  /** 任意: プロジェクトキー (project.* イベント) */
  projectKey?: string;
  /** 任意: プロジェクト clientId */
  clientId?: string;
  /** 任意: プロバイダ (github / google / email / client_credentials) */
  provider?: string;
  /** 任意: IP アドレス */
  ip?: string;
  /** 任意: User-Agent */
  userAgent?: string;
  /** 任意: エラーメッセージ */
  error?: string;
  /** その他フリーフィールド */
  [key: string]: unknown;
}

const LOG_DIR = process.env.LOG_DIR ?? path.resolve(process.cwd(), "logs");
const FILE_OUTPUT_ENABLED = (process.env.LOG_AUTH_FILE ?? "true").toLowerCase() !== "false";

let dirEnsured = false;
function ensureDir(): void {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch (err) {
    console.error("[auth-logger] ログディレクトリ作成失敗:", err instanceof Error ? err.message : err);
  }
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `auth-${date}.log`);
}

/** 認証イベントをコンソール + ファイルに書き出す */
export function logAuthEvent(event: AuthEventBase): void {
  const record = {
    ts: new Date().toISOString(),
    level: event.event.endsWith(".failed") || event.event.endsWith(".rejected") ? "warn" : "info",
    ...event,
  };
  const line = JSON.stringify(record);

  // コンソール
  if (record.level === "warn") {
    console.warn(`[auth] ${line}`);
  } else {
    console.log(`[auth] ${line}`);
  }

  // ファイル (fire-and-forget)
  if (FILE_OUTPUT_ENABLED) {
    ensureDir();
    fs.appendFile(logFilePath(), line + "\n", (err) => {
      if (err) {
        console.error("[auth-logger] ファイル書き込み失敗:", err.message);
      }
    });
  }
}

// ─── 便利ラッパー ────────────────────────────────────────

export function logUserLogin(userId: string, email: string | null, provider: string, ctx?: { ip?: string; userAgent?: string }): void {
  logAuthEvent({
    event: "user.login",
    userId,
    email: email ?? undefined,
    provider,
    ...ctx,
  });
}

export function logUserLoginFailed(email: string | undefined, provider: string, error: string, ctx?: { ip?: string; userAgent?: string }): void {
  logAuthEvent({
    event: "user.login.failed",
    email,
    provider,
    error,
    ...ctx,
  });
}

export function logUserRegister(userId: string, email: string, provider: string, ctx?: { ip?: string }): void {
  logAuthEvent({
    event: "user.register",
    userId,
    email,
    provider,
    ...ctx,
  });
}

export function logUserWsConnect(userId: string, sessionId: string, ctx?: { ip?: string }): void {
  logAuthEvent({
    event: "user.ws.connect",
    userId,
    sessionId,
    ...ctx,
  });
}

export function logUserWsDisconnect(userId: string, sessionId: string): void {
  logAuthEvent({
    event: "user.ws.disconnect",
    userId,
    sessionId,
  });
}

export function logProjectLogin(projectKey: string, clientId: string, ctx?: { ip?: string; userAgent?: string }): void {
  logAuthEvent({
    event: "project.login",
    projectKey,
    clientId,
    provider: "project_credentials",
    ...ctx,
  });
}

export function logProjectLoginFailed(clientId: string | undefined, error: string, ctx?: { ip?: string; userAgent?: string }): void {
  logAuthEvent({
    event: "project.login.failed",
    clientId,
    provider: "project_credentials",
    error,
    ...ctx,
  });
}

export function logProjectWsConnect(projectKey: string, clientId: string, connectionId: string, ctx?: { ip?: string }): void {
  logAuthEvent({
    event: "project.ws.connect",
    projectKey,
    clientId,
    connectionId,
    ...ctx,
  });
}

export function logProjectWsDisconnect(projectKey: string, clientId: string, connectionId: string): void {
  logAuthEvent({
    event: "project.ws.disconnect",
    projectKey,
    clientId,
    connectionId,
  });
}

export function logProjectWsRejected(error: string, ctx?: { ip?: string }): void {
  logAuthEvent({
    event: "project.ws.rejected",
    error,
    ...ctx,
  });
}
