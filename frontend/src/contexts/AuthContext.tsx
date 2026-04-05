import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { auth as authApi, getStoredUser, getAccessToken, setTokens, setStoredUser } from "../lib/api";
import { wsClient } from "../lib/ws-client";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface MfaChallenge {
  mfaToken: string;
  mfaMethods: string[];
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  wsConnected: boolean;
  mfaChallenge: MfaChallenge | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  mfaSendCode: (method: string) => Promise<void>;
  mfaVerify: (method: string, code: string) => Promise<void>;
  mfaCancelChallenge: () => void;
  googleAuthUrl: string;
  githubAuthUrl: string;
  linkGitHubUrl: string;
  linkGoogleUrl: string;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(getStoredUser);
  const [wsConnected, setWsConnected] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [loading, setLoading] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const stored = getStoredUser();
    return !!(stored || (params.get("accessToken") && params.get("refreshToken")));
  });

  // WS 接続
  const connectWs = useCallback(async () => {
    const token = getAccessToken();
    if (!token || wsClient.connected) return;

    try {
      await wsClient.connect(token);
      setWsConnected(true);
      console.log("[AuthContext] WS session connected");
    } catch (err) {
      console.warn("[AuthContext] WS connection failed:", (err as Error).message);
      setWsConnected(false);
    }
  }, []);

  // ユーザーが認証されたら WS 自動接続
  useEffect(() => {
    if (user) {
      connectWs();
    } else {
      wsClient.disconnect();
      setWsConnected(false);
    }
  }, [user, connectWs]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get("accessToken");
    const refreshToken = params.get("refreshToken");
    const authError = params.get("authError");
    const linked = params.get("linked");

    if (authError) {
      console.error("[AuthContext] OAuth error:", authError);
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (linked) {
      console.info("[AuthContext] Account linked:", linked);
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
    const result = await authApi.login({ email, password });

    if (authApi.isMfaChallenge(result)) {
      setMfaChallenge({ mfaToken: result.mfaToken, mfaMethods: result.mfaMethods });
      return;
    }

    const data = result;
    setUser({ id: data.user.id, name: data.user.displayName, email: data.user.email || "", role: data.user.role });
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const data = await authApi.register({ name, email, password });
    setUser({ id: data.user.id, name: data.user.displayName, email: data.user.email || "", role: data.user.role });
  }, []);

  const logout = useCallback(async () => {
    wsClient.disconnect();
    setWsConnected(false);
    await authApi.logout();
    setUser(null);
    setMfaChallenge(null);
  }, []);

  const mfaSendCode = useCallback(async (method: string) => {
    if (!mfaChallenge) throw new Error("No MFA challenge active");
    await authApi.mfaSendCode(mfaChallenge.mfaToken, method);
  }, [mfaChallenge]);

  const mfaVerify = useCallback(async (method: string, code: string) => {
    if (!mfaChallenge) throw new Error("No MFA challenge active");
    const data = await authApi.mfaVerify(mfaChallenge.mfaToken, method, code);
    setMfaChallenge(null);
    setUser({ id: data.user.id, name: data.user.displayName, email: data.user.email || "", role: data.user.role });
  }, [mfaChallenge]);

  const mfaCancelChallenge = useCallback(() => {
    setMfaChallenge(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        wsConnected,
        mfaChallenge,
        login,
        register,
        logout,
        mfaSendCode,
        mfaVerify,
        mfaCancelChallenge,
        googleAuthUrl: authApi.getGoogleAuthUrl(),
        githubAuthUrl: authApi.getGitHubAuthUrl(),
        linkGitHubUrl: authApi.getLinkGitHubUrl(),
        linkGoogleUrl: authApi.getLinkGoogleUrl(),
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
