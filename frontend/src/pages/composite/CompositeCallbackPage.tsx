/**
 * Composite Callback Page
 *
 * OAuth コールバック後にリダイレクトされるページ。
 * auth_code を postMessage で親ウィンドウ (popup の opener) に送信して閉じる。
 *
 * Query params:
 *   code   - auth_code
 *   origin - postMessage 送信先オリジン
 */

import { useEffect, useState } from "react";

export function CompositeCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const origin = params.get("origin");

    if (!code) {
      setError("No auth code received.");
      return;
    }

    if (origin && window.opener) {
      // Popup モード: postMessage で auth_code を送信
      window.opener.postMessage({ type: "cernere:auth", authCode: code }, origin);
      window.close();
    } else if (origin) {
      // Opener がない場合 (iframe 等) — parent に送信を試みる
      try {
        window.parent.postMessage({ type: "cernere:auth", authCode: code }, origin);
      } catch {
        setError("Failed to send auth code to parent window.");
      }
    } else {
      setError("No target origin specified.");
    }
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <div style={{ textAlign: "center", color: "var(--text-muted)" }}>
        {error ? (
          <p style={{ color: "var(--red)" }}>{error}</p>
        ) : (
          <p>Completing authentication...</p>
        )}
      </div>
    </div>
  );
}
