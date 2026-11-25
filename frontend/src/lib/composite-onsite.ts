import { getAccessToken } from "./browser-token-store";
import { CompositeAuthHandoff } from "./composite-auth-handoff";
import { readCompositeLoginRequest } from "./composite-pkce";
import { fetchAllowedOrigins } from "./composite-redirect";

interface Kiosk { lanId: string; lanUrl: string; placeId: string; label: string | null }
export interface OnsiteTicket { mfaToken: string; nonce: string; expiresAt: string; kiosks: Kiosk[] }

function loginRequest() {
  const params = new URLSearchParams(location.search);
  const request = readCompositeLoginRequest(location.search);
  const origin = params.get("origin");
  const redirect = params.get("redirect_uri");
  if (!request || request.code_audience || (!origin && !redirect) || (origin && redirect)) return null;
  return { ...request, target: (origin || redirect)!, targetMode: origin ? "post_message" as const : "redirect" as const };
}

async function post<T>(action: string, signal: AbortSignal, mfaToken?: string): Promise<T> {
  const request = loginRequest();
  const bearer = getAccessToken();
  if (!request || !bearer) throw new Error("Cernere にログインしてから、もう一度お試しください。");
  const res = await fetch(`/api/auth/composite-onsite/${action}`, {
    method: "POST", redirect: "error", cache: "no-store", signal,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, mfaToken }),
  });
  if (!res.ok) throw new Error("現地認証を完了できませんでした。ログイン画面からやり直してください。");
  return await res.json() as T;
}

export async function onsiteAvailable(signal: AbortSignal): Promise<boolean> {
  if (!loginRequest() || !getAccessToken()) return false;
  return (await post<{ available: boolean }>("available", signal)).available;
}

export function beginOnsite(signal: AbortSignal): Promise<OnsiteTicket> {
  return post<OnsiteTicket>("begin", signal);
}

/** Only the opaque challenge goes to the operator-registered LAN kiosk. */
export async function contactKiosk(ticket: OnsiteTicket, kiosk: Kiosk, signal: AbortSignal): Promise<void> {
  const base = new URL(kiosk.lanUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("会場の接続先が無効です。");
  base.pathname = `${base.pathname.replace(/\/$/, "")}/api/mfa/onsite/sessions`;
  const res = await fetch(base, { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: ticket.nonce }) });
  if (res.status !== 202) throw new Error("会場の Os に接続できませんでした。同じ Wi-Fi に接続しているか確認してください。");
}

export async function finishOnsite(ticket: OnsiteTicket, signal: AbortSignal): Promise<"pending" | "completed"> {
  const result = await post<{ authCode?: string; code?: string; consentUrl?: string; pending?: boolean }>("finish", signal, ticket.mfaToken);
  if (result.pending === true) return "pending";
  if (result.code === "consent_required" && result.consentUrl) {
    const url = new URL(result.consentUrl, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/consent") throw new Error("同意画面の接続先が無効です。");
    location.assign(url.href);
    return "completed";
  }
  const request = loginRequest();
  if (!request || !result.authCode) throw new Error("GLab の認可コードを取得できませんでした。");
  const handoff = new CompositeAuthHandoff({ self: false, state: request.state, redirectParam: null,
    origin: request.targetMode === "post_message" ? request.target : null,
    redirectUri: request.targetMode === "redirect" ? request.target : null,
    exchange: async () => { throw new Error("GLab ログインにはサービスの送信先が必要です。"); },
    onError: message => { throw new Error(message); },
  });
  handoff.setAllowedOrigins(await fetchAllowedOrigins());
  signal.throwIfAborted();
  handoff.deliver(result.authCode);
  return "completed";
}
