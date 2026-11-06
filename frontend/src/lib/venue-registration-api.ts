/**
 * 会場ネットワーク限定の新規登録の通信 (spec/feature/venue-network-registration.md §2 / §6)。
 *
 *   start          Cernere で challenge と nonce と候補 kiosk を受け取る
 *   sendToKiosk    会場 LAN 上の Ostiarius (kiosk の lanUrl) へ nonce を送る。会場の外からは届かない
 *   status         Cernere で確認の状態を見る (pending / verified / expired)
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface VenueKiosk { lanId: string; placeId: string; lanUrl: string; label: string | null }
export interface VenueStart { challengeId: string; nonce: string; expiresAt: string; kiosks: VenueKiosk[] }
export type VenueStatus = "pending" | "verified" | "expired";

export class VenueApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new VenueApiError(data.error ?? "会場の確認に失敗しました", res.status);
  return data;
}

/** kiosk の lanUrl に Os の受け口を足す (lanUrl にパスがあってもその下に置く)。 */
export function kioskSessionUrl(lanUrl: string): string {
  const base = lanUrl.endsWith("/") ? lanUrl : `${lanUrl}/`;
  return new URL("api/venue-registration/sessions", base).toString();
}

export const venueRegistrationApi = {
  async start(): Promise<VenueStart> {
    const res = await fetch(`${API_BASE}/api/auth/venue-registration/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "include",
    });
    return readJson<VenueStart>(res);
  },

  async status(challengeId: string): Promise<VenueStatus> {
    const query = new URLSearchParams({ challengeId }).toString();
    const res = await fetch(`${API_BASE}/api/auth/venue-registration/status?${query}`, { credentials: "include" });
    return (await readJson<{ state: VenueStatus }>(res)).state;
  },

  /** 届いたら true。会場の外 (LAN に届かない)・Os の拒否はどちらも false。 */
  async sendToKiosk(kiosk: VenueKiosk, nonce: string, timeoutMs = 5000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Os 側の CORS は Cernere のログイン画面の origin だけを許可する。Cookie は送らない。
      const res = await fetch(kioskSessionUrl(kiosk.lanUrl), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }),
        credentials: "omit", signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
};
