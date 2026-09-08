import { useEffect, useRef, useState } from "react";
import { auth as authApi } from "../lib/api";
import { consumeGoogleBrowserState } from "../lib/google-browser-state";
import { resolveSelfRedirectTarget } from "../lib/composite-auth-handoff";

/** @implements SPEC-GOOGLE-OIDC-HANDOFF */
export function OAuthCallbackPage() {
  const [input] = useState(() => new URLSearchParams(window.location.search));
  const completion = useRef<Promise<unknown> | null>(null);
  const target = useRef<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    // Remove the one-use code before any further browser requests or navigation.
    window.history.replaceState({}, "", window.location.pathname);
    const code = input.get("code");
    if (input.get("error") || !code) {
      setError(input.get("error") || "認証コードがありません。ログインをやり直してください。");
      return;
    }
    if (!completion.current) {
      try {
        const opened = consumeGoogleBrowserState(input.get("browser_state"));
        if (!opened.ok) {
          setError("このタブで開始した Google ログインではありません。ログイン画面からやり直してください。");
          return;
        }
        // 戻り先はこのタブが保持した値を優先し、 無ければサーバの Cr OIDC 継続先を使う。
        target.current = opened.redirect ?? input.get("redirect");
        completion.current = authApi.exchangeAuthCode(code);
      } catch {
        setError("ログイン情報を確認できません。ブラウザの保存機能を確認してください。");
        return;
      }
    }
    // Reuse the promise across StrictMode effect replays; auth codes are consumed only once.
    void completion.current.then(() => {
      if (active) window.location.replace(resolveSelfRedirectTarget(target.current));
    }).catch(() => {
      if (active) setError("Google ログインを完了できませんでした。ログイン画面からやり直してください。");
    });
    return () => { active = false; };
  }, [input]);
  return <main style={{ padding: "2rem" }}>
    <p role="status">{error || "Google ログインを完了しています…"}</p>
    {error && <a href="/login">ログイン画面へ戻る</a>}
  </main>;
}
