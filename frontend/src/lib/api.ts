const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// ── Token Management ──────────────────────────────

function getAccessToken(): string | null {
  return localStorage.getItem("accessToken");
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refreshToken");
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem("accessToken", access);
  localStorage.setItem("refreshToken", refresh);
}

export function clearTokens() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("user");
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

export const profile = {
  async getMyProfile(): Promise<UserProfileData> {
    return request<UserProfileData>("/api/profile");
  },

  async updateMyProfile(body: UpdateProfileBody): Promise<UserProfileData> {
    return request<UserProfileData>("/api/profile", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  async updatePrivacy(privacy: ProfilePrivacy): Promise<void> {
    await request("/api/profile/privacy", {
      method: "PUT",
      body: JSON.stringify(privacy),
    });
  },

  async getPublicProfile(userId: string): Promise<PublicProfile> {
    return request<PublicProfile>(`/api/users/${userId}/profile`);
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
