/**
 * multipart/form-data の最小パーサ。
 *
 * 顔写真アップロードは「ファイル 1 個 + 少数の text field」しか受けないため、
 * 依存を増やさずここで閉じる。汎用パーサではないので、対応するのは
 *   - boundary 区切り
 *   - Content-Disposition の name / filename
 *   - Content-Type (ファイル部のみ)
 * だけ。nested multipart や base64 transfer-encoding は扱わない。
 */

import { AppError } from "../error.js";

export interface MultipartFile {
  name: string;
  filename: string;
  mime: string;
  bytes: Buffer;
}

export interface MultipartForm {
  fields: Record<string, string>;
  files: MultipartFile[];
}

const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

export function parseBoundary(contentType: string): string {
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
    throw AppError.badRequest("Content-Type must be multipart/form-data");
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!boundary) throw AppError.badRequest("multipart boundary is required");
  // RFC 2046 の上限。制御文字を許すと delimiter 解釈が曖昧になる。
  if (boundary.length > 70 || /[^\x20-\x7e]/.test(boundary)) {
    throw AppError.badRequest("Invalid multipart boundary");
  }
  return boundary;
}

function parseHeaders(raw: string): { name: string; filename: string; mime: string } {
  let name = "";
  let filename = "";
  let mime = "application/octet-stream";
  for (const line of raw.split("\r\n")) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!value) continue;
    if (key.toLowerCase() === "content-disposition") {
      name = /name="([^"]*)"/i.exec(value)?.[1] ?? "";
      filename = /filename="([^"]*)"/i.exec(value)?.[1] ?? "";
    } else if (key.toLowerCase() === "content-type") {
      mime = value.split(";")[0].trim().toLowerCase();
    }
  }
  return { name, filename, mime };
}

export function parseMultipart(body: Buffer, contentType: string): MultipartForm {
  const boundary = parseBoundary(contentType);
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const form: MultipartForm = { fields: {}, files: [] };

  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw AppError.badRequest("Malformed multipart body");
  cursor += delimiter.length;

  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).toString() === "--") break; // 終端 delimiter
    if (body.subarray(cursor, cursor + 2).equals(CRLF)) cursor += 2;

    const headerEnd = body.indexOf(DOUBLE_CRLF, cursor);
    if (headerEnd < 0) throw AppError.badRequest("Malformed multipart part");
    const { name, filename, mime } = parseHeaders(body.subarray(cursor, headerEnd).toString("utf8"));

    const contentStart = headerEnd + DOUBLE_CRLF.length;
    const next = body.indexOf(nextDelimiter, contentStart);
    if (next < 0) throw AppError.badRequest("Malformed multipart part");
    const content = body.subarray(contentStart, next);

    if (name) {
      if (filename) form.files.push({ name, filename, mime, bytes: Buffer.from(content) });
      else form.fields[name] = content.toString("utf8");
    }
    cursor = next + CRLF.length + delimiter.length;
  }
  return form;
}

/** 単一ファイル前提の取り出し。0 枚 / 2 枚以上は 400。 */
export function requireSingleFile(form: MultipartForm, field: string): MultipartFile {
  if (form.files.length !== 1 || form.files[0].name !== field) {
    throw AppError.badRequest("Exactly one image part is required");
  }
  return form.files[0];
}
