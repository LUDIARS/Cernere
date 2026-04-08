import { useCallback, useEffect, useState } from "react";
import type { CernereUser } from "../types.js";
import { useCernereAuth } from "./hooks.js";

export interface LoginPageProps {
  /** 認証後のコールバック URL (redirect モード用) */
  callbackUrl: string;
  /** 認証成功時のコールバック (redirect callback ページ用) */
  onSuccess?: (user: CernereUser) => void;
  /** 認証失敗時のコールバック */
  onError?: (error: Error) => void;
  /** true の場合、redirect callback の処理を行う */
  isCallback?: boolean;
}

/**
 * フルページログインコンポーネント。
 * Redirect フローで Cernere にログインする。
 *
 * 使い方:
 * - ログインページ: <LoginPage callbackUrl="/auth/callback" />
 * - コールバックページ: <LoginPage callbackUrl="/auth/callback" isCallback onSuccess={...} />
 */
export function LoginPage({
  callbackUrl,
  onSuccess,
  onError,
  isCallback = false,
}: LoginPageProps) {
  const { loginWithRedirect, handleRedirectCallback, isAuthenticated, user } = useCernereAuth();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // コールバック処理
  useEffect(() => {
    if (!isCallback) return;

    setProcessing(true);
    handleRedirectCallback()
      .then((result) => {
        if (result) {
          onSuccess?.(result.user);
        }
      })
      .catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err.message);
        onError?.(err);
      })
      .finally(() => setProcessing(false));
  }, [isCallback, handleRedirectCallback, onSuccess, onError]);

  const handleLogin = useCallback(() => {
    loginWithRedirect(callbackUrl);
  }, [loginWithRedirect, callbackUrl]);

  if (processing) {
    return <div style={{ textAlign: "center", padding: "48px" }}>認証処理中...</div>;
  }

  if (isAuthenticated && user) {
    return (
      <div style={{ textAlign: "center", padding: "48px" }}>
        ログイン済み: {user.displayName}
      </div>
    );
  }

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "24px",
  };

  const buttonStyle: React.CSSProperties = {
    padding: "14px 32px",
    fontSize: "15px",
    fontWeight: 600,
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    backgroundColor: "#111",
    color: "#fff",
  };

  return (
    <div style={containerStyle}>
      <h2 style={{ marginBottom: "24px", fontWeight: 600 }}>ログイン</h2>
      {error && (
        <p style={{ color: "#c00", marginBottom: "16px", fontSize: "14px" }}>{error}</p>
      )}
      <button style={buttonStyle} onClick={handleLogin}>
        Cernere でログイン
      </button>
    </div>
  );
}
