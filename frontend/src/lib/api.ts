const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Passkey 用は @simplewebauthn/browser を使うので type だけ import
import { startRegistration } from "./webauthn";
import type { PublicKeyCredentialCreationOptionsJSON } from "./webauthn";
import { authorizeAction } from "./action-auth";
import type { ConsentView } from "./consent-api";

// ── Token Management ──────────────────────────────

import { getAccessToken, getRefreshToken, setTokens, clearTokens, usesDeviceSession } from "./browser-token-store";
import { refreshBrowserAccessToken as refreshAccessToken, logoutDeviceSession } from "./browser-refresh";
export { getAccessToken, setTokens, clearTokens };

/**
 * インフラ (Cloudflare Tunnel 等) が全訪問者に付ける cookie。
 * 「アクセスした形跡」の判定に数えると初訪問でも常に true になるため除外する。
 */
const INFRA_COOKIE_NAMES = new Set(["__cf_bm", "_cfuvid", "cf_clearance", "__cflb", "__cfruid"]);

/**
 * このブラウザに「アクセスした形跡」があるか。
 * - 過去にログイン/登録した永続印 (cernere_returning)
 * - 現行/残存セッション (accessToken / user)
 * - インフラ由来を除く first-party cookie
 * のいずれかがあれば true。 ログイン画面の既定タブ判定 (returning→Login / 新規→Register) に使う。
 */
export function hasAccessRecord(): boolean {
  try {
    if (localStorage.getItem("cernere_returning")) return true;
    if (localStorage.getItem("accessToken") || localStorage.getItem("user")) return true;
    if (typeof document !== "undefined") {
      const meaningful = document.cookie.split(";")
        .map((c) => c.split("=")[0]?.trim())
        .filter((name) => name && !INFRA_COOKIE_NAMES.has(name));
      if (meaningful.length > 0) return true;
    }
  } catch {
    // localStorage 不可 (プライベートモード等) は「形跡なし」扱い。
  }
  return false;
}

export function getStoredUser(): { id: string; name: string; email: string; role: string } | null {
  const raw = localStorage.getItem("user");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setStoredUser(user: { id: string; name: string; email: string; role: string }) {
  localStorage.setItem("user", JSON.stringify(user));
}

// ── Core Request ──────────────────────────────────

interface UserProfile {
  id: string;
  /** 表示名。サーバーの me はこの名前で返す (displayName ではない) */
  name: string | null;
  email: string | null;
  role: string;
  hasGoogleAuth: boolean;
  hasGitHubAuth: boolean;
  hasDiscordAuth: boolean;
  discordUsername: string | null;
  hasPassword: boolean;
  hasPasskey: boolean;
  mfaEnabled: boolean;
  mfaMethods: string[];
  hasPhone: boolean;
  phoneVerified: boolean;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (!getAccessToken() && usesDeviceSession()) await refreshAccessToken();
  const token = getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401 && (getRefreshToken() || usesDeviceSession())) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${getAccessToken()}`;
      res = await fetch(url, { ...options, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Auth API ──────────────────────────────────────

interface AuthResponse {
  user: { id: string; displayName: string; email: string | null; role: string };
  accessToken: string;
  refreshToken: string;
}

export const auth = {


  async logout() {
    // 端末側の資格情報は必ず捨てる。 サーバ応答が 5xx / offline でも
    // clearTokens を飛ばすと、 ログアウトしたはずの端末に有効な access token が
    // 残り続ける (legacy 経路と同じく best-effort に揃える)。
    if (usesDeviceSession()) {
      try { await logoutDeviceSession(); }
      finally { clearTokens(); }
      return;
    }
    const refreshToken = getRefreshToken();
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch { /* best-effort */ }
    clearTokens();
  },



  async me(): Promise<UserProfile> {
    return request<UserProfile>("/api/auth/me");
  },

  // ── Passkey (WebAuthn / Face ID / Touch ID / Windows Hello / Android 生体 / 物理キー) ──

  /** 現在のユーザに passkey を新規登録する。 ブラウザが OS の生体認証ダイアログを開く */
  async passkeyRegister(nickname?: string, options?: { platformOnly?: boolean }): Promise<{ ok: true; credentialId: string }> {
    const existing = await this.passkeyList();
    const currentUser = getStoredUser();
    if (existing.items.length > 0 && !currentUser) {
      throw new Error("Current user is unavailable");
    }
    const proof = existing.items.length > 0
      ? await authorizeAction("passkey.register", currentUser!.id)
      : undefined;
    const opts = await request<PublicKeyCredentialCreationOptionsJSON>("/api/auth/passkey/register-begin", {
      method: "POST",
      headers: proof ? { "X-Cernere-Action-Proof": proof } : undefined,
      body: JSON.stringify({}),
    });
    const response = await startRegistration({ optionsJSON: options?.platformOnly
      ? { ...opts, authenticatorSelection: { ...opts.authenticatorSelection, authenticatorAttachment: "platform" } }
      : opts });
    const res = await request<{ ok: true; credentialId: string }>("/api/auth/passkey/register-finish", {
      method: "POST", body: JSON.stringify({ response, nickname: nickname ?? null }),
    });
    return res;
  },



  async passkeyList(): Promise<{ items: Array<{ id: string; credentialId: string; nickname: string | null; deviceType: string; backedUp: boolean; aaguid: string | null; createdAt: string; lastUsedAt: string | null }> }> {
    return request("/api/auth/passkey/list", { method: "POST", body: "{}" });
  },

  /** composite authCode を自分 (Cernere frontend) のトークンに交換する。
   *  /login を composite フローへ一本化した際の self モード完了処理。 */
  async exchangeAuthCode(code: string): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json() as AuthResponse & { error?: string };
    if (!res.ok || !data.accessToken) throw new Error(data.error || "Auth code exchange failed");
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({
      id: data.user.id,
      name: data.user.displayName,
      email: data.user.email || "",
      role: data.user.role,
    });
    return data;
  },



  async passkeyDelete(id: string): Promise<{ ok: true; removed: number }> {
    const proof = await authorizeAction("passkey.delete", id);
    return request("/api/auth/passkey/delete", {
      method: "POST",
      headers: { "X-Cernere-Action-Proof": proof },
      body: JSON.stringify({ id }),
    });
  },

  // ── MFA ──────────────────────────────────────

  // MFA の状態取得と要素の登録/解除は mfaApi (lib/mfa-api.ts) を直接使う。
  // management token を扱う経路をひとつに保つため、ここには再輸出を置かない。

  async mfaSmsSetup(phoneNumber: string): Promise<void> {
    await request("/api/auth/mfa/sms/setup", {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    });
  },

  async mfaSmsVerifyPhone(code: string): Promise<void> {
    await request("/api/auth/mfa/sms/verify-phone", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  async mfaSmsEnable(): Promise<void> {
    await request("/api/auth/mfa/sms/enable", { method: "POST" });
  },

  async mfaSmsDisable(): Promise<void> {
    await request("/api/auth/mfa/sms/disable", { method: "POST" });
  },



  // ── フェデレーション (アカウントリンク) ──────

  async startLinkProvider(
    provider: "github" | "google" | "discord",
    requireStepUp: boolean,
  ): Promise<string> {
    const proof = requireStepUp ? await authorizeAction("oauth.link", provider) : undefined;
    const result = await request<{ authorizationUrl: string }>("/api/auth/link", {
      method: "POST",
      credentials: "include",
      headers: proof ? { "X-Cernere-Action-Proof": proof } : undefined,
      body: JSON.stringify({ provider }),
    });
    return result.authorizationUrl;
  },

  async unlinkProvider(
    provider: "github" | "google" | "discord",
    requireStepUp: boolean,
  ): Promise<void> {
    const proof = requireStepUp ? await authorizeAction("oauth.unlink", provider) : undefined;
    await request("/api/auth/unlink", {
      method: "POST",
      headers: proof ? { "X-Cernere-Action-Proof": proof } : undefined,
      body: JSON.stringify({ provider }),
    });
  },
};

export const faceConsents = {
  /**
   * 自分の顔認証同意の一覧。顔テンプレート・顔写真は Cernere に無く (正本は施設の
   * 受付端末)、ここで見えるのは「どの施設にいつ同意したか」だけ。
   */
  status(): Promise<{ items: Array<{ facilityId: string; consentId: string; policyVersion: string; at: string; reconsentRequired: boolean }> }> {
    return request("/api/identity/face-consent/status");
  },
  /** 同意を撤回する。施設の端末にある登録は失効指示の同期で削除される。 */
  revoke(facilityId?: string): Promise<{ ok: true; revoked: number; facilities: string[] }> {
    const suffix = facilityId ? `?facilityId=${encodeURIComponent(facilityId)}` : "";
    return request(`/api/identity/face-consent${suffix}`, { method: "DELETE" });
  },
};

// ── OIDC Provider consent API ─────────────────────
// Cernere を IdP とする RP (Cloudflare Access 等) の認可同意フロー。
// /oidc/authorize がフロントの /oidc/consent に飛ばし、 ここで承認/拒否する。

export interface OidcConsentInfo {
  clientName: string;
  scopes: string[];
  redirectUri: string;
  reauthenticationRequired: boolean;
  authenticationMessage?: string;
  /** サービスの権限確認 (consent_mode warn/enforce の RP)。off の RP は null で従来の表示 */
  consent: { mode: "warn" | "enforce"; satisfied: boolean; view: ConsentView } | null;
}

export const oidc = {
  async getRequest(requestId: string): Promise<OidcConsentInfo> {
    const token = getAccessToken();
    const res = await fetch(`${API_BASE}/api/auth/oidc/request?request_id=${encodeURIComponent(requestId)}`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json() as OidcConsentInfo & { error?: string };
    if (!res.ok) throw new Error(data.error || "Failed to load authorization request");
    return data;
  },

  /** recommended: 許可した推奨の権限キー。省略は保存済みの同意で進める (consent_mode off の RP は無視される) */
  async approve(requestId: string, recommended?: string[]): Promise<{ redirectTo: string }> {
    const token = getAccessToken();
    const res = await fetch(`${API_BASE}/api/auth/oidc/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      credentials: "include",
      body: JSON.stringify({ request_id: requestId, ...(recommended ? { recommended } : {}) }),
    });
    const data = await res.json() as { redirectTo: string; error?: string };
    if (!res.ok) throw new Error(data.error || "Authorization failed");
    return data;
  },

  async deny(requestId: string): Promise<{ redirectTo: string }> {
    const res = await fetch(`${API_BASE}/api/auth/oidc/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ request_id: requestId }),
    });
    const data = await res.json() as { redirectTo: string; error?: string };
    if (!res.ok) throw new Error(data.error || "Failed to deny authorization");
    return data;
  },
};

// ── Profile API ──────────────────────────────────

export interface ProfilePrivacy {
  bio: boolean;
  roleTitle: boolean;
  expertise: boolean;
  hobbies: boolean;
}

export interface UserProfileData {
  userId: string;
  roleTitle: string;
  bio: string;
  expertise: string[];
  hobbies: string[];
  extra: Record<string, unknown>;
  privacy: ProfilePrivacy;
  createdAt: string;
  updatedAt: string;
}

export interface PublicProfile {
  userId: string;
  displayName: string;
  roleTitle?: string;
  bio?: string;
  expertise?: string[];
  hobbies?: string[];
}

export interface UpdateProfileBody {
  roleTitle?: string;
  bio?: string;
  expertise?: string[];
  hobbies?: string[];
  extra?: Record<string, unknown>;
  privacy?: ProfilePrivacy;
}

// ── Profile API (WS module_request 経由) ────────

import { wsClient } from "./ws-client";

export const profile = {
  async getMyProfile(): Promise<UserProfileData> {
    return wsClient.sendCommand<UserProfileData>("profile", "get");
  },

  /** 表示名 (初回ログイン後に入れる。SPEC-DISPLAY-NAME-DEFERRED) */
  async setDisplayName(displayName: string): Promise<{ displayName: string }> {
    return wsClient.sendCommand<{ displayName: string }>("profile", "set_display_name", { displayName });
  },

  async updateMyProfile(body: UpdateProfileBody): Promise<UserProfileData> {
    return wsClient.sendCommand<UserProfileData>("profile", "update", body);
  },

  async updatePrivacy(privacy: ProfilePrivacy): Promise<void> {
    await wsClient.sendCommand("profile", "update_privacy", { privacy });
  },

  async getPublicProfile(userId: string): Promise<PublicProfile> {
    return wsClient.sendCommand<PublicProfile>("user", "get_profile", { userId });
  },
};

// ── Data Opt-Out API (WS module_request 経由) ───

export interface DataOptOutItem {
  serviceId: string;
  categoryKey: string;
  optedOutAt: string;
}

export interface OptOutRequest {
  serviceId: string;
  categoryKey: string;
  fields?: string[];
}

export const optouts = {
  async list(): Promise<DataOptOutItem[]> {
    // profile.list_optouts は userDataOptouts から全 serviceId (core + プロジェクト)
    // を横断して返す
    return wsClient.sendCommand<DataOptOutItem[]>("profile", "list_optouts");
  },

  async create(body: OptOutRequest): Promise<{ message: string; optout: DataOptOutItem }> {
    // プロジェクトの category_key は "module:xxx" 形式
    if (body.categoryKey.startsWith("module:")) {
      const moduleKey = body.categoryKey.slice("module:".length);
      await wsClient.sendCommand("managed_project", "optout", {
        projectKey: body.serviceId,
        moduleKey,
      });
    } else {
      await wsClient.sendCommand("profile", "optout", body);
    }
    return {
      message: "Opt-out created",
      optout: { serviceId: body.serviceId, categoryKey: body.categoryKey, optedOutAt: new Date().toISOString() },
    };
  },

  async remove(body: OptOutRequest): Promise<{ message: string }> {
    if (body.categoryKey.startsWith("module:")) {
      const moduleKey = body.categoryKey.slice("module:".length);
      await wsClient.sendCommand("managed_project", "remove_optout", {
        projectKey: body.serviceId,
        moduleKey,
      });
    } else {
      await wsClient.sendCommand("profile", "remove_optout", body);
    }
    return { message: "Opt-out removed" };
  },
};

// ── Managed Project データ API ──────────────────

export interface UserProjectData {
  projectKey: string;
  projectName: string;
  schema: Record<string, { type: string; module?: string; description?: string }>;
  data: Record<string, unknown> | null;
}

export const managedProjects = {
  async myData(projectKey: string): Promise<UserProjectData> {
    return wsClient.sendCommand<UserProjectData>("managed_project", "my_data", { projectKey });
  },
  async myDataAll(): Promise<UserProjectData[]> {
    return wsClient.sendCommand<UserProjectData[]>("managed_project", "my_data_all");
  },
  async myOptouts(projectKey: string): Promise<DataOptOutItem[]> {
    return wsClient.sendCommand<DataOptOutItem[]>("managed_project", "list_optouts", { projectKey });
  },
};

// ── Tool Client API ──────────────────────────────

export interface ToolClientData {
  id: string;
  name: string;
  clientId: string;
  ownerUserId: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateToolClientResponse {
  client: ToolClientData;
  clientSecret: string;
}

export const toolClients = {
  async create(name: string, scopes?: string[]): Promise<CreateToolClientResponse> {
    return request<CreateToolClientResponse>("/api/auth/tools", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    });
  },

  async list(): Promise<ToolClientData[]> {
    return request<ToolClientData[]>("/api/auth/tools");
  },

  async remove(id: string): Promise<void> {
    await request(`/api/auth/tools/${id}`, { method: "DELETE" });
  },
};
