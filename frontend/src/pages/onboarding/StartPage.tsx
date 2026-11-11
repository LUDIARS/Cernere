/**
 * はじめての方の入口 (アカウント作成前)。
 *
 * 名前を入れて「はじめる」を押すと、この端末にパスキーを作成し、作成を終えたときに
 * アカウントができる (neco 2026-10-15「はじめるでアカウント作成」)。この画面を開いただけ・
 * 名前を入れただけでは何も作らない。作成後はオンボーディング (リカバリー QR・スマホ・通知) へ進む。
 *
 * 画面を開くと会場のネットワークを確かめる (spec/feature/venue-network-registration.md §2)。確認できたら
 * 会場の組織のメンバー (許可済み) として作る。会場の外では Wi-Fi の案内を出し、例外として続けることもできる。
 *
 * V.O.B の Discord で発行したリンク (?vob=) から来たときは会場確認をせず、そのトークンで V.O.B のメンバーとして作る
 * (spec/feature/vob-discord-registration.md)。
 */

import { useState } from "react";
import { bodyTextStyle, inputStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton } from "../../components/security/panel-styles";
import { signupWithPasskey } from "../../lib/passkey-account-api";
import { MAX_DISPLAY_NAME, normalizeDisplayName, savePendingDisplayName } from "../../lib/pending-display-name";
import { onboardingUrl, readReturnPath } from "./onboarding-return";
import { venueChallengeForSignup } from "../../lib/venue-check";
import { useVenueCheck } from "./useVenueCheck";
import { VenueCheckPanel } from "./VenueCheckPanel";
import { readVobToken } from "./vob-link";

const VENUE_CHALLENGE_INVALID = "venue_challenge_invalid";
const VOB_TOKEN_INVALID = "vob_token_invalid";

export function StartPage() {
  const returnTo = readReturnPath(window.location.search);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outsideVenue, setOutsideVenue] = useState(false);
  const [vobToken] = useState(() => readVobToken(window.location.search));
  const venue = useVenueCheck(vobToken === null);
  const venueChallengeId = vobToken ? undefined : venueChallengeForSignup(venue.state);
  // V.O.B のリンクから来たか、会場確認済みか、会場外 (例外) を選んだときだけ作れる。
  const valid = normalizeDisplayName(name) !== null && (vobToken !== null || venueChallengeId !== undefined || outsideVenue);

  const start = async () => {
    const normalized = normalizeDisplayName(name);
    if (!normalized) return;
    setBusy(true);
    setError("");
    savePendingDisplayName(normalized);
    try {
      await signupWithPasskey(vobToken ? { vobToken } : { venueChallengeId });
      // AuthContext に新しいセッションを読ませるため、全体を読み直して遷移する。
      window.location.assign(onboardingUrl(returnTo));
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === VOB_TOKEN_INVALID) {
        setError("登録リンクが使えなくなりました (期限切れ・使用済み・サーバー未参加・連携済み)。アカウントは作られていません。V.O.B の Discord でもう一度 /登録 を実行してください。");
      } else if (err.code === VENUE_CHALLENGE_INVALID) {
        // 確認の期限切れ・使用済み。アカウントは作られていないので、確かめ直すか例外で続ける。
        setError("会場の確認が使えなくなりました。アカウントは作られていません。もう一度確かめるか、会場の外から続けてください。");
        venue.retry();
      } else {
        setError(err.name === "NotAllowedError" || err.name === "AbortError"
          ? "パスキーの作成が完了しませんでした。アカウントは作られていません。もう一度「はじめる」を押してください。"
          : err.message);
      }
      setBusy(false);
    }
  };

  const back = () => {
    window.location.assign(`/login?${new URLSearchParams({ redirect: returnTo }).toString()}`);
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Cernere をはじめる</h1>
      {vobToken ? (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>V.O.B からの登録</h2>
          <p style={bodyTextStyle}>Discord で受け取ったリンクで登録します。V.O.B のメンバーとして作られます。</p>
        </div>
      ) : (
        <VenueCheckPanel state={venue.state} outsideVenue={outsideVenue} busy={busy}
          onRetry={venue.retry} onOutsideVenueChange={setOutsideVenue} />
      )}
      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>👤 名前</h2>
        <p style={bodyTextStyle}>Cernere とつながるサービスに表示される名前です。あとから変えられます。</p>
        {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
        <input
          value={name}
          maxLength={MAX_DISPLAY_NAME}
          autoComplete="nickname"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) void start(); }}
          placeholder="表示名"
          style={inputStyle}
        />
        <p style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
          「はじめる」を押すと、この端末にパスキーを作成します。作成を終えたときにアカウントができます。
        </p>
        <button type="button" onClick={() => { void start(); }} disabled={busy || !valid} style={{ ...primaryButton(busy || !valid), marginTop: "0.5rem" }}>
          {busy ? "パスキーの作成を待っています…" : "はじめる"}
        </button>
      </div>
      <button type="button" onClick={back} disabled={busy} style={secondaryButton(busy)}>
        パスキーを持っている (ログインに戻る)
      </button>
    </main>
  );
}
