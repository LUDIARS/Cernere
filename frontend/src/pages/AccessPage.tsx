/**
 * 利用許可の状態と申請 (許可制 案 A)。
 *
 * 許可待ちの間は、自分のプロフィール・パスキー・リカバリー QR・通知・端末だけが使える。
 * 他のサービスへのログインや他の人の情報の閲覧は、管理者が許可してからになる。
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  bodyTextStyle, inputStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton,
} from "../components/security/panel-styles";
import { useAuth } from "../contexts/AuthContext";
import { safeReturnPath } from "./onboarding/onboarding-return";
import { userAccess, type MyAccess } from "../lib/user-access-api";

const MAX_PURPOSE = 500;

export function AccessPage() {
  const { wsConnected } = useAuth();
  const [access, setAccess] = useState<MyAccess | null>(null);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const returnTo = new URLSearchParams(window.location.search).get("return");

  const load = useCallback(async () => setAccess(await userAccess.status()), []);
  useEffect(() => { if (wsConnected) void load().catch((e) => setError((e as Error).message)); }, [wsConnected, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openRequest = access?.request?.state === "open" ? access.request : null;

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>利用の許可</h1>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {!access && <p style={bodyTextStyle}>読み込み中…</p>}

      {access?.status === "active" && (
        <div style={panelStyle}>
          <p style={bodyTextStyle}>✓ 利用が許可されています。</p>
          {returnTo && <a href={safeReturnPath(returnTo)} style={{ ...primaryButton(false), display: "inline-block", textDecoration: "none" }}>元の画面に戻る</a>}
        </div>
      )}

      {access?.status === "locked" && (
        <div style={{ ...panelStyle, borderColor: "var(--red)" }}>
          <p style={bodyTextStyle}>このアカウントは停止されています。心当たりがない場合は運用者に連絡してください。</p>
        </div>
      )}

      {access?.status === "pending" && (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>管理者の許可を待っています</h2>
          <p style={bodyTextStyle}>
            許可されるまでは、自分の <Link to="/profile">プロフィール</Link>・<Link to="/security">パスキーとリカバリー QR・通知</Link>・
            <Link to="/devices">端末</Link> だけが使えます。他のサービスへのログインや、他の人の情報の閲覧は、許可された後にできるようになります。
          </p>
          {openRequest ? (
            <>
              <p style={bodyTextStyle}>
                {new Date(openRequest.createdAt).toLocaleString()} に申請しました。管理者が確認するまでお待ちください。
              </p>
              <p style={{ ...bodyTextStyle, whiteSpace: "pre-wrap", color: "var(--text)" }}>{openRequest.purpose}</p>
              <button type="button" disabled={busy} style={secondaryButton(busy)} onClick={() => { void run(() => userAccess.withdraw()); }}>
                申請を取り下げる
              </button>
            </>
          ) : (
            <>
              <p style={bodyTextStyle}>
                どのサービスを、何のために使いたいかを書いて申請してください。管理者は別の連絡手段であなたを確かめることがあります。
                {access.request && access.request.state !== "open" && ` (前回の申請: ${access.request.state})`}
              </p>
              <textarea
                value={purpose}
                maxLength={MAX_PURPOSE}
                rows={4}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="例: ○○ 授業で Actio と Memoria を使うため (担当: △△)"
                style={{ ...inputStyle, resize: "vertical" }}
              />
              <button type="button" disabled={busy || !purpose.trim()} style={{ ...primaryButton(busy || !purpose.trim()), marginTop: "0.75rem" }}
                onClick={() => { void run(() => userAccess.apply(purpose.trim())); }}>
                利用を申請する
              </button>
            </>
          )}
        </div>
      )}
    </main>
  );
}
