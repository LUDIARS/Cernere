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
import { fetchAllowedOrigins, isTargetAllowed } from "../../lib/composite-redirect";

export function CompositeCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const origin = params.get("origin");

      if (!code) {
        setError("No auth code received.");
        return;
      }
      if (!origin) {
        setError("No target origin specified.");
        return;
      }

      // VULNWEB-001: 送信先 origin をサーバ許可リストで検証してから forward する。
      const allowed = await fetchAllowedOrigins();
      if (cancelled) return;
      if (!isTargetAllowed(origin, allowed)) {
        setError("許可されていない送信先のため認証を中止しました。");
        return;
      }
      const targetOrigin = new URL(origin).origin;

      if (window.opener) {
        // Popup モード: postMessage で auth_code を送信
        window.opener.postMessage({ type: "cernere:auth", authCode: code }, targetOrigin);
        window.close();
      } else {
        // Opener がない場合 (iframe 等) — parent に送信を試みる
        try {
          window.parent.postMessage({ type: "cernere:auth", authCode: code }, targetOrigin);
        } catch {
          setError("Failed to send auth code to parent window.");
        }
      }
    })();
    return () => { cancelled = true; };
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
