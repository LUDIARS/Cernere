/** 現地確認 MFA の kiosk 公開鍵レジストリ (admin REST)。 server: http/onsite-kiosk-admin-handler.ts */
import { getAccessToken } from "./browser-token-store";
import { refreshBrowserAccessToken } from "./browser-refresh";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface OnsiteKioskView {
  lanId: string; placeId: string; publicKeyPem: string; lanUrl: string; label: string | null;
  status: "active" | "revoked"; createdAt: string; updatedAt: string; revokedAt: string | null;
}

export interface OnsiteKioskRegistration {
  lanId: string; placeId: string; publicKeyPem: string; lanUrl: string; label?: string;
}

async function adminRequest<T>(path: string, payload?: unknown): Promise<T> {
  let token = getAccessToken();
  if (!token && await refreshBrowserAccessToken()) token = getAccessToken();
  if (!token) throw new Error("ログインし直してください。");
  const response = await fetch(`${API_BASE}/api/admin/onsite-kiosks${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "kiosk 登録の処理に失敗しました。");
  return data;
}

export const onsiteKioskApi = {
  list: async (): Promise<OnsiteKioskView[]> => (await adminRequest<{ kiosks: OnsiteKioskView[] }>("")).kiosks,
  register: async (input: OnsiteKioskRegistration): Promise<OnsiteKioskView> =>
    (await adminRequest<{ kiosk: OnsiteKioskView }>("", input)).kiosk,
  revoke: async (lanId: string): Promise<OnsiteKioskView> =>
    (await adminRequest<{ kiosk: OnsiteKioskView }>(`/${encodeURIComponent(lanId)}/revoke`, {})).kiosk,
};
