/**
 * 顔写真の正規化。
 *
 * - 保存用: 長辺 1024 / JPEG。元画像 (EXIF や巨大な原寸) はそのまま持たない。
 * - 抽出用: sidecar の 200,000 bytes 制限に収まるまで段階的に縮小する。
 *
 * sharp は native module のため、未インストール環境で Cernere 全体が起動不能に
 * ならないよう動的 import する。読めなければ写真経路だけを 503 で fail closed
 * にする (照合経路や既存のテンプレート API には影響させない)。
 */

import { AppError } from "../error.js";

/** sidecar の 200KB 境界より余裕を見て少し下で切る。 */
const SIDECAR_SAFE_BYTES = 190_000;
const STORAGE_LONG_EDGE = 1024;
/** 圧縮爆弾による過大 decode を防ぐ。保存解像度には十分な上限。 */
const MAX_INPUT_PIXELS = 40_000_000;
const ACCEPTED_INPUT_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface NormalizedFacePhoto {
  bytes: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
}
/**
 * sharp の最小インターフェース。specifier をリテラルにしないことで、
 * 型定義が無い環境 (未インストール) でも typecheck を壊さずに扱う。
 * 実行時に読めなければ写真経路だけを 503 にする。
 */
interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: Record<string, unknown>): SharpPipeline;
  jpeg(options: Record<string, unknown>): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
}
type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => SharpPipeline;

const SHARP_MODULE = "sharp";
let sharpPromise: Promise<SharpFactory> | null = null;

async function loadSharp(): Promise<SharpFactory> {
  sharpPromise ??= import(SHARP_MODULE)
    .then((mod: { default?: unknown }) => mod.default as SharpFactory)
    .catch(() => {
      sharpPromise = null;
      throw AppError.serviceUnavailable("Image processing is unavailable");
    });
  return sharpPromise;
}

export function assertAcceptedInputMime(mime: string): void {
  if (!ACCEPTED_INPUT_MIME.has(mime.toLowerCase())) {
    throw AppError.badRequest("Unsupported image type");
  }
}

/** 表示用の正規化。長辺 1024 の JPEG に落とし、メタデータは落とす。 */
export async function normalizeForStorage(input: Buffer): Promise<NormalizedFacePhoto> {
  const sharp = await loadSharp();
  let output;
  try {
    output = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: STORAGE_LONG_EDGE,
        height: STORAGE_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    // 例外に画像バイトが載らないよう、内容を含まない固定文言に置き換える。
    throw AppError.badRequest("Image could not be decoded");
  }
  return {
    bytes: output.data,
    mime: "image/jpeg",
    width: output.info.width,
    height: output.info.height,
  };
}

/**
 * 抽出用に sidecar の上限へ収める。保存画像から作り、返り値は呼び出し側で
 * 使い捨てる (保持しない)。
 */
export async function shrinkForExtraction(normalized: Buffer): Promise<Buffer> {
  if (normalized.length <= SIDECAR_SAFE_BYTES) return normalized;
  const sharp = await loadSharp();
  for (const [edge, quality] of [[1024, 70], [800, 70], [640, 65], [480, 60]] as const) {
    const candidate = await sharp(normalized)
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (candidate.length <= SIDECAR_SAFE_BYTES) return candidate;
    candidate.fill(0);
  }
  throw AppError.unprocessable("Image could not be reduced for face extraction");
}
