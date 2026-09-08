import { useEffect, useRef, useState } from "react";
import { auth as authApi } from "../lib/api";
import { createGoogleBrowserState } from "../lib/google-browser-state";

/** Starts Google login and preserves Cr consent. @implements SPEC-GOOGLE-OIDC-HANDOFF */
export function GoogleSignInPage() {
  const started = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    try {
      const current = new URLSearchParams(window.location.search);
      const target = new URL(authApi.getGoogleAuthUrl(), window.location.origin);
      // 戻り先はサーバへ渡さず、 このタブの sessionStorage だけが保持する。
      target.searchParams.set("browser_state", createGoogleBrowserState(current.get("redirect")));
      const requestId = current.get("oidc_request_id");
      if (requestId) target.searchParams.set("oidc_request_id", requestId);
      window.location.replace(target.toString());
    } catch { setError("Google ログインを開始できません。ブラウザの保存機能を確認してやり直してください。"); }
  }, []);
  return <main style={{ padding: "2rem" }}>
    <p role="status">{error || "Google ログインへ移動しています…"}</p>
    {error && <a href="/login">ログイン画面へ戻る</a>}
  </main>;
}
