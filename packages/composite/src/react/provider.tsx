import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { CernereAuth } from "../client.js";
import type {
  CernereAuthConfig,
  CernereUser,
  CernereAuthResult,
  PopupOptions,
} from "../types.js";

export interface CernereAuthContextValue {
  user: CernereUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  accessToken: string | null;
  loginWithPopup: (options?: PopupOptions) => Promise<CernereAuthResult>;
  loginWithRedirect: (callbackUrl?: string) => void;
  handleRedirectCallback: () => Promise<CernereAuthResult | null>;
  logout: () => void;
}

export const CernereAuthContext = createContext<CernereAuthContextValue | null>(null);

export interface CernereAuthProviderProps extends CernereAuthConfig {
  children: ReactNode;
}

export function CernereAuthProvider({ children, ...config }: CernereAuthProviderProps) {
  const clientRef = useRef<CernereAuth | null>(null);
  if (!clientRef.current) {
    clientRef.current = new CernereAuth(config);
  }
  const client = clientRef.current;

  const [isLoading, setIsLoading] = useState(true);

  // useSyncExternalStore で client の状態変更を React に伝搬
  const subscribe = useCallback((cb: () => void) => client.subscribe(cb), [client]);
  const getSnapshot = useCallback(() => client.getUser(), [client]);
  const user = useSyncExternalStore(subscribe, getSnapshot);

  // 初期化: 保存済みトークンで認証状態を復元
  useEffect(() => {
    client.initialize().finally(() => setIsLoading(false));
  }, [client]);

  const loginWithPopup = useCallback(
    (options?: PopupOptions) => client.loginWithPopup(options),
    [client],
  );
  const loginWithRedirect = useCallback(
    (callbackUrl?: string) => client.loginWithRedirect(callbackUrl),
    [client],
  );
  const handleRedirectCallback = useCallback(
    () => client.handleRedirectCallback(),
    [client],
  );
  const logout = useCallback(() => client.logout(), [client]);

  const value = useMemo<CernereAuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null && client.getAccessToken() !== null,
      isLoading,
      accessToken: client.getAccessToken(),
      loginWithPopup,
      loginWithRedirect,
      handleRedirectCallback,
      logout,
    }),
    [user, isLoading, client, loginWithPopup, loginWithRedirect, handleRedirectCallback, logout],
  );

  return (
    <CernereAuthContext.Provider value={value}>
      {children}
    </CernereAuthContext.Provider>
  );
}
