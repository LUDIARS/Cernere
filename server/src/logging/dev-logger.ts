/**
 * 開発時詳細ログ
 *
 * `NODE_ENV=development` または `CERNERE_DEV_LOG=true` のときだけ有効。
 * 認証フロー / DB アクセス / WS 状態遷移などの中間ステップを 1 行ずつ
 * 標準出力に吐く。本番では完全に抑制する (パフォーマンス & ログ量対策)。
 *
 * 環境変数:
 *   CERNERE_DEV_LOG=true   ... 本番 NODE_ENV でも強制有効化
 *   CERNERE_DEV_LOG=false  ... development でも無効化
 */

import { config } from "../config.js";

function shouldLog(): boolean {
  const explicit = process.env.CERNERE_DEV_LOG;
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  return config.isDevelopment;
}

const ENABLED = shouldLog();

function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 1 行詳細ログ (dev のみ). 第二引数はオブジェクトを JSON 化して付与 */
export function devLog(label: string, data?: Record<string, unknown>): void {
  if (!ENABLED) return;
  const payload = data ? ` ${safeStringify(data)}` : "";
  console.log(`[dev] ${label}${payload}`);
}

/** dev でのみエラーをスタックトレース付きで出力 */
export function devError(label: string, err: unknown, data?: Record<string, unknown>): void {
  if (!ENABLED) return;
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  const payload = data ? ` ${safeStringify(data)}` : "";
  console.error(`[dev] ${label}${payload}\n${stack}`);
}

/** dev で使う Drizzle 用 logger (drizzle({ ..., logger }) に渡す) */
export const drizzleDevLogger = ENABLED
  ? {
      logQuery(query: string, params: unknown[]): void {
        const paramsStr = params.length > 0 ? ` -- params: ${safeStringify(params)}` : "";
        console.log(`[db] ${query}${paramsStr}`);
      },
    }
  : undefined;

export const DEV_LOG_ENABLED = ENABLED;
