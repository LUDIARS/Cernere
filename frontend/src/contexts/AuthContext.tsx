import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { auth as authApi, getStoredUser, getAccessToken, setTokens, setStoredUser } from "../lib/api";
import { usesDeviceSession } from "../lib/browser-token-store";
import { refreshBrowserAccessToken } from "../lib/browser-refresh";
import { wsClient } from "../lib/ws-client";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  wsConnected: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(getStoredUser);
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const stored = getStoredUser();
    return !!(stored || (params.get("accessToken") && params.get("refreshToken")));
  });

  // A login/logout in another tab must not retain this tab's previous account or socket.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "user" || event.key === null) {
        const stored = getStoredUser();
        if (stored?.id !== user?.id) { wsClient.disconnect(); window.location.reload(); }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [user?.id]);

  // WS 接続
  const connectWs = useCallback(async () => {
    if (wsClient.connected) return;
    // device session の access token はメモリ上のみに持つため、 リロード直後は必ず空。
    // ここで refresh しないと WS が永久に張られず、 端末管理 UI が操作不能になる。
    let token = getAccessToken();
    if (!token && usesDeviceSession() && await refreshBrowserAccessToken()) token = getAccessToken();
    if (!token) return;

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
    // link 失敗のうち、 定型コードで返るもの (現状は Discord の重複連携)。
    // 拾わないと ?linkError=... が URL に残ったまま無反応になる。
    const linkError = params.get("linkError");

    if (authError) {
      console.error("[AuthContext] OAuth error:", authError);
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (linkError) {
      console.error("[AuthContext] Account link failed:", linkError);
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

  const logout = useCallback(async () => {
    await authApi.logout();
    wsClient.disconnect();
    setWsConnected(false);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        wsConnected,
        logout,
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
