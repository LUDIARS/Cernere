/**
 * 「はじめる」の前に入れた名前を、アカウント作成後のオンボーディングへ渡す (SPEC-DISPLAY-NAME-DEFERRED)。
 *
 * アカウントは「はじめる」でパスキーを作成し終えたときにできる (neco 2026-10-15)。名前はその前の
 * 画面で受け取るが、保存は作成後のセッションで行う。sessionStorage に置き、保存できたら消す。
 * 保存先が使えない環境では null を返し、オンボーディングの名前入力にフォールバックする。
 */

const KEY = "cernere.pendingDisplayName";
export const MAX_DISPLAY_NAME = 80;

export function normalizeDisplayName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME) return null;
  return trimmed;
}

export function savePendingDisplayName(name: string, storage: Storage | null = safeSession()): void {
  try { storage?.setItem(KEY, name); } catch { /* 使えなければオンボーディングで入れ直す */ }
}

export function takePendingDisplayName(storage: Storage | null = safeSession()): string | null {
  try {
    const value = storage?.getItem(KEY) ?? null;
    return value === null ? null : normalizeDisplayName(value);
  } catch {
    return null;
  }
}

export function clearPendingDisplayName(storage: Storage | null = safeSession()): void {
  try { storage?.removeItem(KEY); } catch { /* noop */ }
}

function safeSession(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}
