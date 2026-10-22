/**
 * 使っている端末 A で、引き継ぎ要求を承認する (account-federation §4.1-3 / §4.2)。
 *
 * 相手の端末の概略と、既存アカウントならそのアカウントで使っていたサービスを見せ、相手の画面に出ている
 * 4 桁を入れてもらってから、この端末のパスキーで承認する。番号はこちらには出さない。
 */

import { useState } from "react";
import { federationApprover, federationErrorMessage, type ApproverView } from "../../lib/federation-api";
import { bodyTextStyle, inputStyle, messageStyle, panelStyle, panelTitleStyle, primaryButton } from "../security/panel-styles";
import { ServiceUsageWarning } from "./ServiceUsageWarning";

export interface ApproveRequestPanelProps {
  view: ApproverView;
  onChange: (view: ApproverView) => void;
}

export function ApproveRequestPanel({ view, onChange }: ApproveRequestPanelProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await federationApprover.approve(view, code.trim()));
    } catch (e) {
      setError(federationErrorMessage(e));
      if ((e as { code?: string }).code === "federation_join_code_locked") onChange({ ...view, state: "locked" });
    } finally {
      setBusy(false);
    }
  };

  const existing = view.kind === "existing_account";
  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>🔗 {existing ? "アカウントの連携を承認する" : "端末の追加を承認する"}</h2>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}

      {view.state === "approved" || view.state === "completed" ? (
        <div style={messageStyle(false)}>
          承認しました。{existing ? "相手のアカウントでパスキーの確認を終えると連携します。" : "相手の端末でパスキーを作ると、この端末と同じアカウントとして使えるようになります。"}
        </div>
      ) : view.state === "locked" ? (
        <p style={bodyTextStyle}>この端末の追加は無効になりました。最初からやり直してください。</p>
      ) : view.state === "open" ? (
        <p style={bodyTextStyle}>相手の端末で QR を読むのを待っています…</p>
      ) : (
        <>
          <p style={{ ...bodyTextStyle, color: "var(--text)" }}>
            <strong>{view.device ?? "別の端末"}</strong> が{existing ? "既存のアカウントとして" : ""}このアカウントに加わろうとしています。
            その端末の画面に出ている <strong>4 桁の番号</strong> を入力し、この端末のパスキーで承認してください。
            自分の端末でなければ承認しないでください。
          </p>
          {existing && <ServiceUsageWarning services={view.joinerServices} subject="相手のアカウント" />}
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{4}"
            maxLength={4}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="0000"
            aria-label="相手の端末に出ている 4 桁の番号"
            style={{ ...inputStyle, maxWidth: "8rem", letterSpacing: "0.3em", textAlign: "center", fontFamily: "monospace" }}
          />
          <div style={{ marginTop: "0.75rem" }}>
            <button type="button" onClick={() => { void approve(); }} disabled={busy || code.length !== 4} style={primaryButton(busy || code.length !== 4)}>
              {busy ? "パスキーを確認しています…" : "パスキーで承認する"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
