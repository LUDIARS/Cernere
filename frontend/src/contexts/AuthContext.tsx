import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { auth as authApi, getStoredUser, setTokens, setStoredUser } from "../lib/api";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  googleAuthUrl: string;
  githubAuthUrl: string;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(getStoredUser);
  const [loading, setLoading] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const stored = getStoredUser();
    return !!(stored || (params.get("accessToken") && params.get("refreshToken")));
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get("accessToken");
    const refreshToken = params.get("refreshToken");
    const authError = params.get("authError");

    if (authError) {
      console.error("[AuthContext] OAuth error:", authError);
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (accessToken && refreshToken) {
      setTokens(accessToken, refreshToken);
      window.history.replaceState({}, "", window.location.pathname);
    }

    const stored = getStoredUser();
    if (stored || (accessToken && refreshToken)) {
      authApi.me()
        .then((me) => {
          const u = { id: me.id, name: me.displayName, email: me.email || "", role: me.role };
          setUser(u);
          setStoredUser(u);
        })
        .catch(() => setUser(null))
        .finally(() => setLoading(false));
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await authApi.login({ email, password });
    setUser({ id: data.user.id, name: data.user.displayName, email: data.user.email || "", role: data.user.role });
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const data = await authApi.register({ name, email, password });
    setUser({ id: data.user.id, name: data.user.displayName, email: data.user.email || "", role: data.user.role });
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        googleAuthUrl: authApi.getGoogleAuthUrl(),
        githubAuthUrl: authApi.getGitHubAuthUrl(),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
