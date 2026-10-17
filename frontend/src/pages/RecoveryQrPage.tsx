/**
 * リカバリー QR による回復 (SPEC-RECOVERY-QR-USE)。
 *
 * QR はカメラ (BarcodeDetector がある環境)・画像ファイル・手入力で読む。読み取りはブラウザ内で行い、
 * 外部サービスへ送らない。新しいパスキーを作ると 24 時間の回復待機に入り、その間は今の端末
 * (残っていれば) から取り消せる。期限後に「回復を完了する」で新しいパスキーを使ってログインする。
 */

import { useEffect, useRef, useState } from "react";
import { bodyTextStyle, inputStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton } from "../components/security/panel-styles";
import { recoveryWithCode } from "../lib/passkey-account-api";
import { createQrDetector, decodeQrFromFile } from "../lib/recovery-qr-image";
import { onboardingUrl, readReturnPath } from "./onboarding/onboarding-return";

type Phase = "input" | "registering" | "pending" | "confirming";

export function RecoveryQrPage() {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [eligibleAt, setEligibleAt] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canScan = Boolean(createQrDetector()) && Boolean(navigator.mediaDevices?.getUserMedia);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  };
  useEffect(() => stopCamera, []);

  const scan = async () => {
    const detector = createQrDetector();
    if (!detector) return;
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const tick = async () => {
        if (!streamRef.current) return;
        const found = await detector.detect(video).catch(() => []);
        if (found[0]?.rawValue) {
          setCode(found[0].rawValue);
          stopCamera();
          return;
        }
        requestAnimationFrame(() => { void tick(); });
      };
      void tick();
    } catch {
      stopCamera();
      setError("カメラを使えませんでした。画像ファイルか手入力で読み込んでください。");
    }
  };

  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    const decoded = await decodeQrFromFile(file).catch(() => null);
    if (decoded) setCode(decoded);
    else setError("この画像からは QR を読み取れませんでした。");
  };

  const start = async () => {
    setPhase("registering");
    setError("");
    try {
      const result = await recoveryWithCode.start(code);
      setEligibleAt(result.eligibleAt);
      setCode("");
      setPhase("pending");
    } catch (e) {
      setError((e as Error).message);
      setPhase("input");
    }
  };

  const confirm = async () => {
    setPhase("confirming");
    setError("");
    try {
      await recoveryWithCode.confirm();
      // 回復で古い QR は使えなくなったので、オンボーディングで新しい QR を作らせる。
      window.location.assign(onboardingUrl(readReturnPath(window.location.search)));
    } catch (e) {
      setError((e as Error).message);
      setPhase(eligibleAt ? "pending" : "input");
    }
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>リカバリー QR で戻す</h1>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}

      {(phase === "input" || phase === "registering") && (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>1. QR を読み込む</h2>
          <p style={bodyTextStyle}>
            登録のときに保存したリカバリー QR を読み込み、この端末に新しいパスキーを作ります。
            作ってから <strong>24 時間後</strong> に回復が完了します (その間に、なくしたはずの端末から取り消されると回復しません)。
          </p>
          {canScan && !scanning && (
            <button type="button" onClick={() => { void scan(); }} style={secondaryButton(false)}>カメラで読み取る</button>
          )}
          <video ref={videoRef} muted playsInline style={{ width: "100%", display: scanning ? "block" : "none", marginTop: "0.5rem" }} />
          {scanning && <button type="button" onClick={stopCamera} style={{ ...secondaryButton(false), marginTop: "0.5rem" }}>カメラを止める</button>}
          <label style={{ ...bodyTextStyle, display: "block", marginTop: "0.75rem" }}>
            画像ファイルから読み込む
            <input type="file" accept="image/*" onChange={(e) => { void fromFile(e.target.files?.[0]); }} style={{ display: "block", marginTop: "0.25rem" }} />
          </label>
          <label style={{ ...bodyTextStyle, display: "block" }}>
            手入力 (画像の下に印字された文字列)
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} style={{ ...inputStyle, fontFamily: "monospace", marginTop: "0.25rem" }} />
          </label>
          <button type="button" onClick={() => { void start(); }} disabled={!code.trim() || phase === "registering"}
            style={{ ...primaryButton(!code.trim() || phase === "registering"), marginTop: "0.75rem" }}>
            {phase === "registering" ? "パスキーを作っています…" : "新しいパスキーを作る"}
          </button>
        </div>
      )}

      {(phase === "pending" || phase === "confirming") && (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>2. 24 時間待つ</h2>
          <p style={bodyTextStyle}>
            回復の手続きを始めました。<strong>{new Date(eligibleAt).toLocaleString()}</strong> 以降に、
            下のボタンで新しいパスキーを使って回復を完了してください。それまでは今までのパスキーも使えます。
          </p>
          <p style={bodyTextStyle}>この画面を閉じても大丈夫です。期限後にこのページを開き直して「回復を完了する」を押してください。</p>
        </div>
      )}

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>回復を完了する</h2>
        <p style={bodyTextStyle}>24 時間が過ぎたら、この端末に作った新しいパスキーで完了します。完了すると、古いパスキーとすべての端末のログインは使えなくなります。</p>
        <button type="button" onClick={() => { void confirm(); }} disabled={phase === "confirming"} style={primaryButton(phase === "confirming")}>
          {phase === "confirming" ? "確認しています…" : "回復を完了する"}
        </button>
      </div>
    </main>
  );
}
