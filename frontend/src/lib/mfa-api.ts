/** MFA settings transport. Tickets and enrollment keys remain in component memory. */
import { authorizeAction } from "./action-auth";
import { getAccessToken } from "./browser-token-store";
import { refreshBrowserAccessToken } from "./browser-refresh";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
export type MfaMethod = "totp" | "email";
export interface MfaStatus {
  mfaEnabled: boolean; methods: MfaMethod[]; totpEnabled: boolean; emailEnabled: boolean;
  hasPassword: boolean; hasPasskey: boolean; hasEmail: boolean; totpAvailable: boolean; emailMfaAvailable: boolean;
  hasPhone: boolean; phoneVerified: boolean; smsAvailable: false;
}
export interface MfaChallenge { mfaRequired: true; mfaToken: string; mfaMethods: MfaMethod[] }
export interface MfaManagement { managementToken: string }
export interface TotpSetup { secret: string; provisioningUri: string }

async function mfaRequest<T>(action: string, payload?: unknown, proof?: string): Promise<T> {
  let token = getAccessToken();
  if (!token && await refreshBrowserAccessToken()) token = getAccessToken();
  if (!token) throw new Error("ログインし直してください。");
  const response = await fetch(`${API_BASE}/api/auth/mfa/${action}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      ...(proof ? { "X-Cernere-Action-Proof": proof } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "MFA の処理に失敗しました。");
  return data;
}

export const mfaApi = {
  status: (): Promise<MfaStatus> => mfaRequest("status"),
  begin: (password: string): Promise<MfaManagement | MfaChallenge> => mfaRequest("manage/begin", { password }),
  async beginWithPasskey(userId: string): Promise<MfaManagement> {
    const proof = await authorizeAction("mfa.manage", userId);
    return mfaRequest("manage/begin", {}, proof);
  },
  verify: (mfaToken: string, method: MfaMethod, code: string): Promise<MfaManagement> =>
    mfaRequest("manage/verify", { mfaToken, method, code }),
  send: (mfaToken: string): Promise<void> => mfaRequest("manage/send-code", { mfaToken, method: "email" }),
  totpSetup: (managementToken: string): Promise<TotpSetup> => mfaRequest("totp/setup", { managementToken }),
  emailSetup: (managementToken: string): Promise<void> => mfaRequest("email/setup", { managementToken }),
  change: (managementToken: string, method: MfaMethod, enable: boolean, code = ""): Promise<void> =>
    mfaRequest(`${method}/${enable ? "enable" : "disable"}`, { managementToken, code }),
};
