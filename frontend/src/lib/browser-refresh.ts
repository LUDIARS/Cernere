/** One refresh per tab, coordinated across tabs where Web Locks are available. */
import { clearTokens, getRefreshToken, setTokens, usesDeviceSession } from "./browser-token-store";
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
let pending: Promise<boolean> | null = null;

async function deviceRefresh(): Promise<boolean> {
  const rotationId = sessionStorage.getItem("cernere_rotation_id") ?? crypto.randomUUID();
  sessionStorage.setItem("cernere_rotation_id", rotationId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(API_BASE + "/api/auth/device/session", { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "X-Cernere-Rotation-Id": rotationId }, body: "{}", signal: AbortSignal.timeout(10_000) });
    if (response.status === 409 && attempt === 0) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
    if (!response.ok) {
      if (response.status === 401) clearTokens();
      return false;
    }
    const data = await response.json() as { accessToken: string };
    setTokens(data.accessToken, "");
    sessionStorage.removeItem("cernere_rotation_id");
    return true;
  }
  return false;
}

async function refresh(): Promise<boolean> {
  try {
    if (usesDeviceSession()) return await deviceRefresh();
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    const response = await fetch(API_BASE + "/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { if (response.status === 401) clearTokens(); return false; }
    const data = await response.json() as { accessToken: string; refreshToken: string };
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch { return false; /* Retain credentials and rotationId after transient failure. */ }
}

export function refreshBrowserAccessToken(): Promise<boolean> {
  if (pending) return pending;
  const run = async (): Promise<boolean> => navigator.locks ? await navigator.locks.request("cernere-session-refresh", refresh) : await refresh();
  const flight = run().finally(() => { pending = null; });
  pending = flight;
  return flight;
}

export async function logoutDeviceSession(): Promise<void> {
  const response = await fetch(API_BASE + "/api/auth/device/logout", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("端末のログアウトを確認できませんでした。再試行してください。");
}
