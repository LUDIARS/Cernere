const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Passkey 用は @simplewebauthn/browser を使うので type だけ import
import {
  startRegistration, startAuthentication,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import { authorizeAction } from "./action-auth";

// ── Token Management ──────────────────────────────

export function getAccessToken(): string | null {
  return localStorage.getItem("accessToken");
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refreshToken");
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem("accessToken", access);
  localStorage.setItem("refreshToken", refresh);
  // 「このブラウザは一度アクセス済み」の永続印。 ログアウト (clearTokens) では
  // 消さないので、 再訪時にログイン画面を既定表示する判定に使う。
  localStorage.setItem("cernere_returning", "1");
}

export function clearTokens() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("user");
  // cernere_returning は残す (アクセス形跡は保持し、 次回もログインを優先表示)。
}

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
  name?: string;
  displayName: string;
  email: string | null;
  role: string;
  hasGoogleAuth: boolean;
  hasPassword: boolean;
  mfaEnabled: boolean;
  mfaMethods: string[];
  hasPhone: boolean;
  phoneVerified: boolean;
}

// ── MFA Types ────────────────────────────────────

interface MfaChallengeResponse {
  mfaRequired: true;
  mfaToken: string;
  mfaMethods: string[];
}

interface TotpSetupResponse {
  secret: string;
  provisioningUri: string;
}

interface MfaStatusResponse {
  mfaEnabled: boolean;
  methods: string[];
  totpEnabled: boolean;
  hasPhone: boolean;
  phoneVerified: boolean;
  hasEmail: boolean;
  smsAvailable: boolean;
  emailMfaAvailable: boolean;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  const token = getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401 && getRefreshToken()) {
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

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearTokens();
      return false;
    }
    const data = await res.json() as { accessToken: string; refreshToken: string };
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

// ── Auth API ──────────────────────────────────────

interface AuthResponse {
  user: { id: string; displayName: string; email: string | null; role: string };
  accessToken: string;
  refreshToken: string;
}

type LoginResponse = AuthResponse | MfaChallengeResponse;

function isMfaChallenge(res: LoginResponse): res is MfaChallengeResponse {
  return "mfaRequired" in res && res.mfaRequired === true;
}

export const auth = {
  async register(body: { name: string; email: string; password: string }): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as AuthResponse & { error?: string };
    if (!res.ok) throw new Error(data.error || "Registration failed");
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({
      id: data.user.id,
      name: data.user.displayName,
      email: data.user.email || "",
      role: data.user.role,
    });
    return data;
  },

  async login(body: { email: string; password: string }): Promise<LoginResponse> {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as (AuthResponse | MfaChallengeResponse) & { error?: string };
    if (!res.ok) throw new Error(data.error || "Login failed");

    // MFA チャレンジの場合はトークンを保存しない
    if (isMfaChallenge(data)) {
      return data;
    }

    const authData = data as AuthResponse;
    setTokens(authData.accessToken, authData.refreshToken);
    setStoredUser({
      id: authData.user.id,
      name: authData.user.displayName,
      email: authData.user.email || "",
      role: authData.user.role,
    });
    return authData;
  },

  async logout() {
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

  getGoogleAuthUrl() {
    return "/auth/google/login";
  },

  getGitHubAuthUrl() {
    return "/auth/github/login";
  },

  async me(): Promise<UserProfile> {
    return request<UserProfile>("/api/auth/me");
  },

  // ── Passkey (WebAuthn / Face ID / Touch ID / Windows Hello / Android 生体 / 物理キー) ──

  /** 現在のユーザに passkey を新規登録する。 ブラウザが OS の生体認証ダイアログを開く */
  async passkeyRegister(nickname?: string): Promise<{ ok: true; credentialId: string }> {
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
    const response = await startRegistration({ optionsJSON: opts });
    const res = await request<{ ok: true; credentialId: string }>("/api/auth/passkey/register-finish", {
      method: "POST", body: JSON.stringify({ response, nickname: nickname ?? null }),
    });
    return res;
  },

  /** パスワードを作らず、最初の passkey を資格情報にしてアカウントを作成する。
   *  email は任意 (Windows Hello 等だけで登録可)。 email 無しアカウントの
   *  他デバイス追加はログイン後の device-link で行う。 */
  async passkeySignup(name: string, email?: string): Promise<AuthResponse> {
    const begin = await fetch(`${API_BASE}/api/auth/passkey/signup-begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(email ? { name, email } : { name }),
    });
    const beginData = await begin.json() as {
      signupId?: string;
      options?: PublicKeyCredentialCreationOptionsJSON;
      error?: string;
    };
    if (!begin.ok || !beginData.signupId || !beginData.options) {
      throw new Error(beginData.error || "Passkey registration failed");
    }
    const response: RegistrationResponseJSON = await startRegistration({
      optionsJSON: beginData.options,
    });
    const finish = await fetch(`${API_BASE}/api/auth/passkey/signup-finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signupId: beginData.signupId, response }),
    });
    const data = await finish.json() as AuthResponse & { error?: string };
    if (!finish.ok) throw new Error(data.error || "Passkey registration failed");
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({
      id: data.user.id,
      name: data.user.displayName,
      email: data.user.email || "",
      role: data.user.role,
    });
    return data;
  },

  /** passkey でログイン。 email を渡すとそのユーザの credentials を allow に詰める */
  async passkeyLogin(email?: string): Promise<AuthResponse> {
    const begin = await fetch(`${API_BASE}/api/auth/passkey/login-begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email ?? "" }),
    });
    const beginData = await begin.json() as
      { options: PublicKeyCredentialRequestOptionsJSON; challengeOwner: string; error?: string };
    if (!begin.ok) throw new Error(beginData.error || "Passkey login failed");
    const response: AuthenticationResponseJSON = await startAuthentication({ optionsJSON: beginData.options });
    const finish = await fetch(`${API_BASE}/api/auth/passkey/login-finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, challengeOwner: beginData.challengeOwner }),
    });
    const data = await finish.json() as AuthResponse & { error?: string };
    if (!finish.ok) throw new Error(data.error || "Passkey login failed");
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({
      id: data.user.id,
      name: data.user.displayName,
      email: data.user.email || "",
      role: data.user.role,
    });
    return data;
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

  /** 他デバイス登録用の one-time URL を発行する (要ログイン + step-up)。 */
  async passkeyDeviceLinkCreate(): Promise<{ url: string; expiresIn: number }> {
    const existing = await this.passkeyList();
    const currentUser = getStoredUser();
    if (!currentUser) throw new Error("Current user is unavailable");
    const proof = existing.items.length > 0
      ? await authorizeAction("passkey.device_link", currentUser.id)
      : undefined;
    return request("/api/auth/passkey/device-link", {
      method: "POST",
      headers: proof ? { "X-Cernere-Action-Proof": proof } : undefined,
      body: JSON.stringify({}),
    });
  },

  /** 新しい端末側: device-link URL の token でこの端末の passkey を登録し、
   *  そのままログイン状態にする。 */
  async passkeyDeviceRegister(token: string, nickname?: string): Promise<AuthResponse> {
    const begin = await fetch(`${API_BASE}/api/auth/passkey/device-register-begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const beginData = await begin.json() as {
      ceremonyId?: string;
      options?: PublicKeyCredentialCreationOptionsJSON;
      account?: { displayName: string };
      error?: string;
    };
    if (!begin.ok || !beginData.ceremonyId || !beginData.options) {
      throw new Error(beginData.error || "Device registration failed");
    }
    const response: RegistrationResponseJSON = await startRegistration({
      optionsJSON: beginData.options,
    });
    const finish = await fetch(`${API_BASE}/api/auth/passkey/device-register-finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ceremonyId: beginData.ceremonyId, response, ...(nickname ? { nickname } : {}) }),
    });
    const data = await finish.json() as AuthResponse & { error?: string };
    if (!finish.ok) throw new Error(data.error || "Device registration failed");
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

  isMfaChallenge,

  async mfaStatus(): Promise<MfaStatusResponse> {
    return request<MfaStatusResponse>("/api/auth/mfa/status");
  },

  async mfaTotpSetup(): Promise<TotpSetupResponse> {
    return request<TotpSetupResponse>("/api/auth/mfa/totp/setup", { method: "POST" });
  },

  async mfaTotpEnable(code: string): Promise<void> {
    await request("/api/auth/mfa/totp/enable", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  async mfaTotpDisable(code: string): Promise<void> {
    await request("/api/auth/mfa/totp/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

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

  async mfaEmailEnable(): Promise<void> {
    await request("/api/auth/mfa/email/enable", { method: "POST" });
  },

  async mfaEmailDisable(): Promise<void> {
    await request("/api/auth/mfa/email/disable", { method: "POST" });
  },

  async mfaSendCode(mfaToken: string, method: string): Promise<void> {
    await fetch(`${API_BASE}/api/auth/mfa/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken, method }),
    });
  },

  async mfaVerify(mfaToken: string, method: string, code: string): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/api/auth/mfa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken, method, code }),
    });
    const data = await res.json() as AuthResponse & { error?: string };
    if (!res.ok) throw new Error(data.error || "MFA verification failed");
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({
      id: data.user.id,
      name: data.user.displayName,
      email: data.user.email || "",
      role: data.user.role,
    });
    return data;
  },

  // ── フェデレーション (アカウントリンク) ──────

  getLinkGitHubUrl() {
    return "/auth/link/github";
  },

  getLinkGoogleUrl() {
    return "/auth/link/google";
  },

  async unlinkProvider(provider: string): Promise<void> {
    await request("/api/auth/unlink", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
  },
};

// ── OIDC Provider consent API ─────────────────────
// Cernere を IdP とする RP (Cloudflare Access 等) の認可同意フロー。
// /oidc/authorize がフロントの /oidc/consent に飛ばし、 ここで承認/拒否する。

export interface OidcConsentInfo {
  clientName: string;
  scopes: string[];
  redirectUri: string;
}

export const oidc = {
  async getRequest(requestId: string): Promise<OidcConsentInfo> {
    const res = await fetch(`${API_BASE}/api/auth/oidc/request?request_id=${encodeURIComponent(requestId)}`, {
      credentials: "include",
    });
    const data = await res.json() as OidcConsentInfo & { error?: string };
    if (!res.ok) throw new Error(data.error || "Failed to load authorization request");
    return data;
  },

  async approve(requestId: string): Promise<{ redirectTo: string }> {
    const token = getAccessToken();
    const res = await fetch(`${API_BASE}/api/auth/oidc/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      credentials: "include",
      body: JSON.stringify({ request_id: requestId }),
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
