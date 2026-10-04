/**
 * 利用者端末 → 施設 LAN 上の Ostiarius kiosk の通信 (契約 E)。
 *
 *   POST {lanUrl}/api/mfa/onsite/sessions          { nonce } → 202 { sessionId, expiresAt } / 409 kiosk_busy
 *   GET  {lanUrl}/api/mfa/onsite/sessions/:id      → { state, error? }
 *
 * 端末が kiosk に渡すのは nonce だけ。 userId や操作内容は送らない。
 * LAN の外からは届かないこと自体が「現地に居る」ことの最初の条件になる。
 */

export type KioskSessionState = "waiting" | "submitted" | "rejected" | "expired";

export class KioskBusyError extends Error {
  constructor() { super("kiosk_busy"); this.name = "KioskBusyError"; }
}

const REQUEST_TIMEOUT_MS = 8_000;

function kioskUrl(lanUrl: string, path: string): string {
  return `${lanUrl.replace(/\/+$/, "")}${path}`;
}

export async function openKioskSession(lanUrl: string, nonce: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(kioskUrl(lanUrl, "/api/mfa/onsite/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
    // The nonce must reach only the kiosk that was listed; never follow a redirect elsewhere.
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as { sessionId?: unknown; error?: unknown };
  if (response.status === 409 && body.error === "kiosk_busy") throw new KioskBusyError();
  if (!response.ok || typeof body.sessionId !== "string") throw new Error(`kiosk session failed: HTTP ${response.status}`);
  return body.sessionId;
}

export async function readKioskSession(lanUrl: string, sessionId: string, fetchImpl: typeof fetch = fetch): Promise<KioskSessionState> {
  const response = await fetchImpl(kioskUrl(lanUrl, `/api/mfa/onsite/sessions/${encodeURIComponent(sessionId)}`), {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as { state?: unknown };
  if (!response.ok) throw new Error(`kiosk session status failed: HTTP ${response.status}`);
  const state = body.state;
  if (state === "waiting" || state === "submitted" || state === "rejected" || state === "expired") return state;
  throw new Error("kiosk session status is invalid");
}

/** Cernere の MFA verify が「kiosk の確認待ち」を返したか (409 onsite_pending)。 */
export function isOnsitePending(error: unknown): boolean {
  return error instanceof Error && error.message.includes("onsite_pending");
}
