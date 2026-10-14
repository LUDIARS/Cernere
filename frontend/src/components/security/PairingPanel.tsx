/**
 * 別端末 (スマホなど) の追加 (SPEC-DEVICE-PAIRING / SPEC-FIRST-LOGIN-PHONE-QR)。
 *
 * この端末に QR を出す → 追加する端末で読んでパスキーを作る → 追加する端末に出た 4 桁を
 * ここで入力し、この端末のパスキーで承認する。番号はこちらには出さない (QR を盗み見た人が
 * 先に登録しても、手元の端末の番号が無ければ承認できない)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { pairing, type PairingStatus } from "../../lib/passkey-account-api";
import {
  bodyTextStyle, inputStyle, messageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton,
} from "./panel-styles";

const POLL_MS = 3000;

export interface PairingPanelProps {
  title?: string;
  /** 承認まで終わったとき */
  onAdded?: () => void;
}

export function PairingPanel({ title = "📱 別の端末を追加する", onAdded }: PairingPanelProps) {
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const timer = useRef<number | null>(null);

  const stopPolling = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopPolling, []);

  const start = async () => {
    setBusy(true);
    setError("");
    setInfo("");
    setStatus(null);
    setCode("");
    try {
      const created = await pairing.create();
      setPairingId(created.pairingId);
      setQr(await QRCode.toDataURL(created.url, { width: 240, margin: 1 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const poll = useCallback(async (id: string) => {
    try {
      const next = await pairing.status(id);
      setStatus(next);
      if (next.state !== "waiting") stopPolling();
      if (next.state === "candidate") setQr("");
    } catch (e) {
      setError((e as Error).message);
      stopPolling();
    }
  }, []);

  useEffect(() => {
    if (!pairingId) return;
    stopPolling();
    timer.current = window.setInterval(() => { void poll(pairingId); }, POLL_MS);
    return stopPolling;
  }, [pairingId, poll]);

  const approve = async () => {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      await pairing.approve(status, code.trim());
      setStatus({ ...status, state: "approved" });
      setInfo("追加しました。追加した端末で「ログイン」を押すと使えるようになります。");
      onAdded?.();
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(err.message);
      if (err.code === "pairing_match_locked") setStatus({ ...status, state: "rejected" });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!status) return;
    setBusy(true);
    try {
      await pairing.reject(status.pairingId);
      setStatus({ ...status, state: "rejected" });
      setInfo("拒否しました。心当たりがなければ /security で出来事を確認してください。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const state = status?.state ?? (pairingId ? "waiting" : null);

  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>{title}</h2>
      <p style={bodyTextStyle}>
        スマホなど別の端末でもログインできるようにします。下のボタンで QR を出し、追加したい端末のカメラで読み取ってください。
        この QR は <strong>3 分</strong>で無効になります。<strong>他人に見せたり、写真を送ったりしないでください。</strong>
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {info && <div style={messageStyle(false)}>{info}</div>}

      {(state === null || state === "expired" || state === "rejected" || state === "approved") && (
        <button type="button" onClick={() => { void start(); }} disabled={busy} style={primaryButton(busy)}>
          {state === null ? "QR を表示する" : state === "approved" ? "さらに別の端末を追加する" : "QR を出し直す"}
        </button>
      )}
      {state === "expired" && <p style={bodyTextStyle}>QR の期限が切れました。出し直してください。</p>}

      {state === "waiting" && qr && (
        <div style={{ textAlign: "center" }}>
          <img src={qr} alt="別の端末で読み取る QR コード" width={240} height={240} />
          <p style={bodyTextStyle}>追加する端末で読み取るのを待っています…</p>
        </div>
      )}

      {state === "candidate" && status && (
        <div>
          <p style={{ ...bodyTextStyle, color: "var(--text)" }}>
            <strong>{status.candidateLabel ?? "別の端末"}</strong> がパスキーを作りました。
            その端末の画面に出ている <strong>4 桁の番号</strong> を入力して承認してください。
            自分の端末でなければ「拒否」を押してください。
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{4}"
            maxLength={4}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="0000"
            style={{ ...inputStyle, maxWidth: "8rem", letterSpacing: "0.3em", textAlign: "center", fontFamily: "monospace" }}
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="button" onClick={() => { void approve(); }} disabled={busy || code.length !== 4} style={primaryButton(busy || code.length !== 4)}>
              承認する
            </button>
            <button type="button" onClick={() => { void reject(); }} disabled={busy} style={secondaryButton(busy)}>
              拒否
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
