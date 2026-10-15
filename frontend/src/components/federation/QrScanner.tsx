/**
 * QR の読み取り (account-federation §5)。
 *
 * カメラ (getUserMedia, facingMode environment) の映像を jsQR で読む。カメラが使えない・拒否されたときは
 * 画像ファイル (撮った写真・スクリーンショット) の読み取りに切り替える。映像も画像もブラウザの中だけで処理し、
 * サーバーへは送らない。
 */

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { decodeQrFromFile } from "../../lib/recovery-qr-image";
import { bodyTextStyle, messageStyle, secondaryButton } from "../security/panel-styles";

export interface QrScannerProps {
  /** 読めた文字列。true を返したら読み取りを止める */
  onRead: (text: string) => boolean | void;
  onCancel?: () => void;
}

const SCAN_INTERVAL_MS = 250;

export function QrScanner({ onRead, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraState, setCameraState] = useState<"starting" | "on" | "unavailable">("starting");
  const [error, setError] = useState("");
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let stopped = false;
    const canvas = document.createElement("canvas");

    const stop = () => {
      stopped = true;
      if (timer !== null) window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };

    const scan = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || stopped) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx || canvas.width === 0) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
      if (found?.data && onReadRef.current(found.data) === true) stop();
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) { stop(); return; }
        const video = videoRef.current;
        if (!video) { stop(); return; }
        video.srcObject = stream;
        await video.play();
        setCameraState("on");
        timer = window.setInterval(scan, SCAN_INTERVAL_MS);
      } catch {
        // 拒否・カメラ無し: 画像ファイルの読み取りに切り替える。
        setCameraState("unavailable");
      }
    })();
    return stop;
  }, []);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    const text = await decodeQrFromFile(file).catch(() => null);
    if (!text) {
      setError("画像から QR を読めませんでした。QR 全体がはっきり写った画像を選んでください。");
      return;
    }
    onReadRef.current(text);
  };

  return (
    <div>
      {cameraState !== "unavailable" && (
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ width: "100%", maxWidth: 360, borderRadius: "var(--radius)", background: "#000", display: "block" }}
        />
      )}
      {cameraState === "starting" && <p style={bodyTextStyle}>カメラを起動しています…</p>}
      {cameraState === "on" && <p style={bodyTextStyle}>QR をカメラに向けてください。</p>}
      {cameraState === "unavailable" && (
        <p style={bodyTextStyle}>カメラを使えません。QR を撮った写真やスクリーンショットを選んでください。</p>
      )}
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      <label style={{ ...bodyTextStyle, display: "block" }}>
        画像から読む:{" "}
        <input type="file" accept="image/*" onChange={(e) => { void readFile(e.target.files?.[0]); }} />
      </label>
      {onCancel && (
        <button type="button" onClick={onCancel} style={secondaryButton(false)}>やめる</button>
      )}
    </div>
  );
}
