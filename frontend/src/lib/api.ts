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

  async login(body: { email: string; password: string }): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as AuthResponse & { error?: string };
    if (!res.ok) throw new Error(data.error || "Login failed");
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({
      id: data.user.id,
      name: data.user.displayName,
      email: data.user.email || "",
      role: data.user.role,
    });
    return data;
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
};
