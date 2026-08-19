/**
 * Ostiarius face-sidecar (FastAPI) クライアント。
 *
 *   POST /v1/analyze  multipart: image=<bytes>, want=embedding
 *     -> { faces: [{ embedding: base64(float32 little-endian[512]), quality: { pass, ... } }] }
 * 埋め込みベクトルと画像バイトは戻り値としてのみ扱い、ログ・例外文言へ載せない。
 */

import { config } from "../config.js";
import { AppError } from "../error.js";

export interface FaceExtractionResult {
  /** float32[512] の raw bytes。呼び出し側で封緘後にゼロ化する。 */
  embedding: Buffer;
  quality: number;
  modelId: string;
}

const EMBEDDING_BYTES = 512 * Float32Array.BYTES_PER_ELEMENT;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isValidEmbedding(embedding: Buffer): boolean {
  const view = new DataView(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  let hasSignal = false;
  for (let offset = 0; offset < embedding.length; offset += Float32Array.BYTES_PER_ELEMENT) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) return false;
    if (value !== 0) hasSignal = true;
  }
  return hasSignal;
}

export function isFaceSidecarConfigured(): boolean {
  try {
    void sidecarBase();
    return Number.isSafeInteger(config.faceSidecarTimeoutMs) && config.faceSidecarTimeoutMs > 0;
  } catch {
    return false;
  }
}

function sidecarBase(): string {
  const raw = config.faceSidecarUrl.trim();
  if (!raw) throw AppError.serviceUnavailable("Face sidecar is not configured");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw AppError.serviceUnavailable("Face sidecar URL is invalid"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || url.search || url.hash) {
    throw AppError.serviceUnavailable("Face sidecar URL is invalid");
  }
  return url.toString().replace(/\/+$/, "");
}

async function call(path: string, init: RequestInit): Promise<Response> {
  if (!Number.isSafeInteger(config.faceSidecarTimeoutMs) || config.faceSidecarTimeoutMs <= 0) {
    throw AppError.serviceUnavailable("Face sidecar timeout is invalid");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, config.faceSidecarTimeoutMs);
  try {
    // 生体画像を別 origin へ転送しない。sidecar の redirect は設定事故として拒否する。
    return await fetch(`${sidecarBase()}${path}`, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw AppError.serviceUnavailable("Face sidecar is unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1 枚の画像から 512d を取り出す。顔 0 件 / quality.pass=false は 422。
 * 画像は sidecar の 200KB 制限に収めてから渡すこと (face-photo-image 参照)。
 */
export async function extractFaceEmbedding(image: Buffer, mime: string): Promise<FaceExtractionResult> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)], { type: mime }), "face.jpg");
  form.append("want", "embedding");
  const res = await call("/v1/analyze", { method: "POST", body: form });
  if (res.status === 413) throw AppError.unprocessable("Image is too large for face extraction");
  if (!res.ok) throw AppError.serviceUnavailable("Face extraction failed");

  let parsed: unknown;
  try { parsed = await res.json(); }
  catch { throw AppError.serviceUnavailable("Face extraction returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object") {
    throw AppError.serviceUnavailable("Face extraction returned an invalid response");
  }
  const body = parsed as {
    modelId?: string;
    model_id?: string;
    faces?: Array<{ embedding?: string; quality?: { pass?: boolean; score?: number } }>;
  };
  if (!Array.isArray(body.faces) || body.faces.length !== 1) {
    throw AppError.unprocessable(body.faces?.length ? "multiple_faces_detected" : "no_face_detected");
  }
  const face = body.faces[0];
  if (!face?.embedding) throw AppError.unprocessable("no_face_detected");
  if (face.quality?.pass !== true) throw AppError.unprocessable("face_quality_rejected");
  if (face.embedding.length > 4096 || !BASE64_PATTERN.test(face.embedding)) {
    throw AppError.serviceUnavailable("Face extraction returned an invalid embedding");
  }
  const embedding = Buffer.from(face.embedding, "base64");
  if (embedding.length !== EMBEDDING_BYTES
    || embedding.toString("base64") !== face.embedding
    || !isValidEmbedding(embedding)) {
    embedding.fill(0);
    throw AppError.serviceUnavailable("Face extraction returned an invalid embedding");
  }
  const score = face.quality.score ?? 1;
  const modelId = body.modelId ?? body.model_id;
  if (!Number.isFinite(score)
    || typeof modelId !== "string"
    || modelId.trim() !== modelId
    || modelId.length < 1
    || modelId.length > 128
    || /[\u0000-\u001f\u007f]/.test(modelId)) {
    embedding.fill(0);
    throw AppError.serviceUnavailable("Face extraction returned invalid metadata");
  }
  return {
    embedding,
    quality: Math.min(100, Math.max(0, Math.round(score * 100))),
    modelId,
  };
}
