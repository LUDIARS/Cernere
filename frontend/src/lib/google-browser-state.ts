/** Tab-local state prevents an unsolicited OAuth handoff URL from signing this browser in. */
const STORAGE_KEY = "cernere.google.oidc.state";

/** state と対で保持する戻り先。 URL 由来の戻り先を信用しないため、 このタブだけが決める。 */
interface StoredGoogleBrowserState {
  state: string;
  redirect: string | null;
}

function read(): StoredGoogleBrowserState | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { state, redirect } = value as Record<string, unknown>;
    if (typeof state !== "string" || !state) return null;
    return { state, redirect: typeof redirect === "string" ? redirect : null };
  } catch {
    return null;
  }
}

/** @implements SPEC-GOOGLE-OIDC-HANDOFF */
export function createGoogleBrowserState(redirect: string | null = null): string {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ state, redirect } satisfies StoredGoogleBrowserState));
  return state;
}

/**
 * 開始したタブの state と一致したときだけ消費し、 そのタブが決めた戻り先を返す。
 * 不一致なら `ok: false` で、 code の交換自体を行わせない。
 * @implements SPEC-GOOGLE-OIDC-HANDOFF
 */
export function consumeGoogleBrowserState(state: string | null): { ok: boolean; redirect: string | null } {
  const stored = read();
  if (!state || !stored || state !== stored.state) return { ok: false, redirect: null };
  sessionStorage.removeItem(STORAGE_KEY);
  return { ok: true, redirect: stored.redirect };
}
