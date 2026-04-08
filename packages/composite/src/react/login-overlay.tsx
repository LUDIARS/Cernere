import { useCallback } from "react";
import type { CernereUser, PopupOptions } from "../types.js";
import { useCernereAuth } from "./hooks.js";

export interface LoginOverlayProps {
  /** オーバーレイの表示状態 */
  open: boolean;
  /** 閉じた時のコールバック */
  onClose: () => void;
  /** 認証成功時のコールバック */
  onSuccess?: (user: CernereUser) => void;
  /** 認証失敗時のコールバック */
  onError?: (error: Error) => void;
  /** Popup ウィンドウのサイズ */
  popupOptions?: PopupOptions;
  /** オーバーレイの背景色 (デフォルト: "rgba(0, 0, 0, 0.5)") */
  backdropStyle?: React.CSSProperties;
}

/**
 * SPA 用オーバーレイログインコンポーネント。
 * Popup ウィンドウで Cernere ログインを開始し、背景をオーバーレイで覆う。
 */
export function LoginOverlay({
  open,
  onClose,
  onSuccess,
  onError,
  popupOptions,
  backdropStyle,
}: LoginOverlayProps) {
  const { loginWithPopup } = useCernereAuth();

  const handleLogin = useCallback(async () => {
    try {
      const result = await loginWithPopup(popupOptions);
      onSuccess?.(result.user);
      onClose();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message === "Login popup was closed.") {
        onClose();
      } else {
        onError?.(err);
      }
    }
  }, [loginWithPopup, popupOptions, onSuccess, onError, onClose]);

  if (!open) return null;

  const defaultBackdrop: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    zIndex: 9999,
  };

  const panelStyle: React.CSSProperties = {
    background: "#fff",
    borderRadius: "8px",
    padding: "32px",
    textAlign: "center",
    maxWidth: "360px",
    width: "100%",
  };

  const buttonStyle: React.CSSProperties = {
    padding: "12px 24px",
    fontSize: "14px",
    fontWeight: 600,
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    backgroundColor: "#111",
    color: "#fff",
    width: "100%",
  };

  const cancelStyle: React.CSSProperties = {
    marginTop: "12px",
    padding: "8px 16px",
    fontSize: "13px",
    border: "1px solid #ddd",
    borderRadius: "6px",
    cursor: "pointer",
    backgroundColor: "transparent",
    color: "#666",
    width: "100%",
  };

  return (
    <div style={{ ...defaultBackdrop, ...backdropStyle }} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: "0 0 20px", fontSize: "15px", color: "#333" }}>
          Cernere アカウントでログイン
        </p>
        <button style={buttonStyle} onClick={handleLogin}>
          ログイン
        </button>
        <button style={cancelStyle} onClick={onClose}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
