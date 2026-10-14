/**
 * 別端末の追加で、QR を読んだ側の画面 (SPEC-DEVICE-PAIRING)。
 *
 * 1. fragment の token を読み、すぐ履歴から消す (Referer・履歴に残さない)
 * 2. 追加先のアカウントを表示して同意を求める (他人の QR を読まされた場合に気づけるように)
 * 3. この端末にパスキーを作る。ここではログインしない
 * 4. 照合番号を表示する。元の端末でこの番号を入力して承認されたら、パスキーでログインできる
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { bodyTextStyle, pageStyle, panelStyle, primaryButton, secondaryButton } from "../components/security/panel-styles";
import { pairing } from "../lib/passkey-account-api";

type Phase = "loading" | "consent" | "registering" | "waiting" | "error" | "declined";

function readToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "";
}

export function DeviceRegisterPage() {
  const [token] = useState(readToken);
  const [phase, setPhase] = useState<Phase>("loading");
  const [begin, setBegin] = useState<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON; account: { label: string } } | null>(null);
  const [matchCode, setMatchCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    window.history.replaceState({}, "", window.location.pathname);
    if (!token) {
      setError("QR コードの読み取り結果が見つかりません。元の端末で QR を出し直して、もう一度読み取ってください。");
      setPhase("error");
      return;
    }
    pairing.registerBegin(token)
      .then((b) => { setBegin(b); setPhase("consent"); })
      .catch((e) => { setError((e as Error).message); setPhase("error"); });
  }, [token]);

  const register = async () => {
    if (!begin) return;
    setPhase("registering");
    try {
      const result = await pairing.registerFinish(begin);
      setMatchCode(result.matchCode);
      setPhase("waiting");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>この端末を追加する</h1>

      {phase === "loading" && <p style={bodyTextStyle}>確認しています…</p>}

      {phase === "consent" && begin && (
        <div style={panelStyle}>
          <p style={{ ...bodyTextStyle, color: "var(--text)" }}>
            <strong>{begin.account.label}</strong> のアカウントに、この端末のパスキーを追加します。
          </p>
          <p style={bodyTextStyle}>
            自分のアカウントでなければ、追加しないでください。他人から「ログインのためにこの QR を読んで」と頼まれた場合は、相手のアカウントに入ってしまいます。
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={() => { void register(); }} style={primaryButton(false)}>パスキーを作って追加する</button>
            <button type="button" onClick={() => setPhase("declined")} style={secondaryButton(false)}>やめる</button>
          </div>
        </div>
      )}

      {phase === "registering" && <p style={bodyTextStyle}>この端末の生体認証または PIN で確認してください…</p>}

      {phase === "waiting" && (
        <div style={panelStyle}>
          <p style={bodyTextStyle}>元の端末で、次の番号を入力して承認してください。</p>
          <p style={{ fontSize: "2.5rem", fontFamily: "monospace", letterSpacing: "0.3em", textAlign: "center", margin: "1rem 0" }}>{matchCode}</p>
          <p style={bodyTextStyle}>承認されたら、下のボタンからこの端末のパスキーでログインできます。番号を他人に伝えないでください。</p>
          <Link to="/login" style={{ ...primaryButton(false), display: "inline-block", textDecoration: "none" }}>ログインへ</Link>
        </div>
      )}

      {phase === "declined" && <p style={bodyTextStyle}>追加しませんでした。この画面は閉じてかまいません。</p>}

      {phase === "error" && <p role="alert" style={{ color: "var(--red)" }}>{error}</p>}
    </main>
  );
}
