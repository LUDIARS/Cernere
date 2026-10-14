/**
 * リカバリー QR の画像 (SPEC-RECOVERY-QR)。
 *
 * 生成と読み取りはブラウザ内で行い、秘密値を外部サービスやサーバーの画像処理に渡さない。
 * 画像には QR・発行日・手入力用の文字列・注意書きだけを入れ、氏名や userId は印字しない。
 */

import jsQR from "jsqr";
import QRCode from "qrcode";

const WIDTH = 720;
const QR_SIZE = 440;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** QR と説明を 1 枚の PNG にして data URL を返す。 */
export async function renderRecoveryQrPng(code: string, issuedAt: string): Promise<string> {
  const qr = await QRCode.toDataURL(code, { width: QR_SIZE, margin: 2, errorCorrectionLevel: "M" });
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("QR の画像を作れませんでした"));
    image.src = qr;
  });

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = 1040;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を作れませんでした");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111111";
  ctx.font = "bold 32px sans-serif";
  ctx.fillText("Cernere リカバリー QR", 40, 64);
  ctx.font = "20px sans-serif";
  ctx.fillText(`発行日: ${issuedAt.slice(0, 10)}`, 40, 100);
  ctx.drawImage(image, (WIDTH - QR_SIZE) / 2, 120, QR_SIZE, QR_SIZE);

  let y = 600;
  ctx.font = "bold 20px sans-serif";
  for (const line of wrap(ctx, "この画像を持つ人はアカウントを取り戻せます。他人に見せたり送ったりしないでください。", WIDTH - 80)) {
    ctx.fillText(line, 40, y);
    y += 30;
  }
  ctx.font = "18px sans-serif";
  for (const line of wrap(ctx, "端末と同じクラウド写真庫だけに置かず、印刷して保管するのがおすすめです。使うときは Cernere の「リカバリー QR で戻す」から読み込みます。", WIDTH - 80)) {
    ctx.fillText(line, 40, y);
    y += 28;
  }
  y += 16;
  ctx.font = "16px monospace";
  ctx.fillText("カメラが使えないときの手入力用:", 40, y);
  y += 26;
  for (const line of wrap(ctx, code, WIDTH - 80)) {
    ctx.fillText(line, 40, y);
    y += 24;
  }
  return canvas.toDataURL("image/png");
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 画像ファイルから QR を読む。読めなければ null。 */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data.data, data.width, data.height)?.data ?? null;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

/** カメラの映像から QR を読む (BarcodeDetector がある環境のみ)。 */
export function createQrDetector(): BarcodeDetectorLike | null {
  const Ctor = (globalThis as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
  return Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
}
