import { useEffect, useState } from "react";
import { usePasskeyLogin } from "@ludiars/cernere-composite/ui";
import { useCompositeLoginSession } from "../../hooks/useCompositeLoginSession";
import type { LoginChoice } from "./LoginEntry";

/** Mounted only by an explicit click; contributes status, never a second login UI. */
export function LoginAttempt({ self, choice, onBusy }: { self: boolean; choice: LoginChoice; onBusy: (busy: boolean) => void }) {
  const params = new URLSearchParams(window.location.search);
  const [error, setError] = useState("");
  const [delivering, setDelivering] = useState(false);
  const session = useCompositeLoginSession({ self, origin: self ? null : params.get("origin"),
    redirectUri: self ? null : params.get("redirect_uri"), redirectParam: params.get("redirect"), apiBase: "",
    crossDevice: choice.crossDevice, enrollAfterLogin: params.get("device_add_skipped") !== "1" });
  const passkey = usePasskeyLogin({ api: session.adapter, autoStartReady: session.passkeyAutoReady,
    onResponse: response => {
      if (response.authCode) { setDelivering(true); session.deliver(response.authCode); }
      else setError(response.error ?? "ログインできませんでした。もう一度お試しください。");
    }, onError: setError });
  const message = error || session.handoffError || session.blockedReason
    || (passkey.phase === "unsupported" ? "このブラウザはパスキーに対応していません。" : "")
    || (passkey.phase === "fallback" ? "ログインは完了していません。もう一度お試しください。" : "");
  useEffect(() => {
    const waiting = session.blockedReason === "送信先を確認しています…";
    onBusy(waiting || (delivering && !session.handoffError) || (!message && (passkey.phase === "running" || !passkey.hasAttempted)));
  }, [onBusy, message, session.blockedReason, passkey.phase, passkey.hasAttempted, delivering, session.handoffError]);
  return <p role="status" style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)", overflowWrap: "anywhere" }}>
    {message || "認証を進めています…"}
  </p>;
}
