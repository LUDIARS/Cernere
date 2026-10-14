/**
 * リカバリー QR の発行とダウンロード (SPEC-RECOVERY-QR)。
 *
 * 初回 (作成直後・回復確定直後) は追加の確認なしで発行し、それ以外の再発行はこの端末の
 * パスキーで確かめる。平文はこの画面でだけ扱い、閉じたら二度と表示できない (再発行になる)。
 * ダウンロードを押しても保存できたとは限らないので、任意で保存した画像を読み戻して確かめる。
 */

import { useState } from "react";
import { getStoredUser } from "../../lib/api";
import { recoveryCode } from "../../lib/passkey-account-api";
import { decodeQrFromFile, downloadDataUrl, renderRecoveryQrPng } from "../../lib/recovery-qr-image";
import {
  bodyTextStyle, messageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton,
} from "./panel-styles";

export interface RecoveryCodePanelProps {
  /** 初回発行 (追加の確認なし) で出してよいか。recoveryCode.status() の canIssueWithoutProof */
  withoutProof: boolean;
  /** すでに有効なコードがあるか (再発行の注意を出す) */
  hasActiveCode: boolean;
  /** ダウンロードまで済んだとき */
  onSaved?: () => void;
}

export function RecoveryCodePanel({ withoutProof, hasActiveCode, onSaved }: RecoveryCodePanelProps) {
  const [image, setImage] = useState("");
  const [code, setCode] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [downloaded, setDownloaded] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const issue = async () => {
    const user = getStoredUser();
    if (!user) { setError("ログインが必要です"); return; }
    setBusy(true);
    setError("");
    try {
      const issued = await recoveryCode.issue(user.id, withoutProof);
      setCode(issued.code);
      setIssuedAt(issued.issuedAt);
      setImage(await renderRecoveryQrPng(issued.code, issued.issuedAt));
      setDownloaded(false);
      setVerified(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    downloadDataUrl(image, `cernere-recovery-${issuedAt.slice(0, 10)}.png`);
    setDownloaded(true);
    onSaved?.();
  };

  const verifyFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setVerified((await decodeQrFromFile(file)) === code);
    } catch {
      setVerified(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>🔑 リカバリー QR</h2>
      <p style={bodyTextStyle}>
        すべての端末をなくしたときに、この QR でアカウントを取り戻せます (取り戻しには 24 時間かかり、その間は今の端末から取り消せます)。
        <strong>この画像を持つ人は誰でもアカウントを取り戻す手続きを始められます。</strong>
        印刷して保管するか、端末とは別の場所に保存してください。
      </p>
      {hasActiveCode && !image && (
        <p style={bodyTextStyle}>すでに発行済みです。作り直すと、前の QR は使えなくなります。</p>
      )}
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}

      {!image && (
        <button type="button" onClick={() => { void issue(); }} disabled={busy} style={primaryButton(busy)}>
          {hasActiveCode ? "リカバリー QR を作り直す" : "リカバリー QR を作る"}
        </button>
      )}

      {image && (
        <div>
          <img src={image} alt="リカバリー QR" style={{ width: "100%", maxWidth: 360, display: "block", margin: "0 auto 0.75rem", border: "1px solid var(--border)" }} />
          <button type="button" onClick={download} style={primaryButton(false)}>
            {downloaded ? "もう一度ダウンロード" : "画像をダウンロード"}
          </button>
          {downloaded && (
            <div style={{ marginTop: "0.75rem" }}>
              <label style={bodyTextStyle}>
                保存できたか確かめる (任意): 保存した画像を選んでください
                <input type="file" accept="image/*" onChange={(e) => { void verifyFile(e.target.files?.[0]); }} style={{ display: "block", marginTop: "0.25rem" }} />
              </label>
              {verified === true && <div style={messageStyle(false)}>✓ 保存した画像から QR を読み取れました。</div>}
              {verified === false && <div role="alert" style={messageStyle(true)}>この画像からは今の QR を読み取れません。もう一度ダウンロードしてください。</div>}
            </div>
          )}
          <button type="button" onClick={() => { setImage(""); setCode(""); }} style={{ ...secondaryButton(false), marginTop: "0.75rem" }}>
            閉じる (この QR は二度と表示できません)
          </button>
        </div>
      )}
    </div>
  );
}
