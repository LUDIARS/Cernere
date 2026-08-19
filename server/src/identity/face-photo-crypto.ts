/**
 * 顔写真の封緘 / 開封 (AES-256-GCM)。
 *
 * face-template-crypto.ts と同じ方式だが **鍵を分ける**。テンプレート鍵が
 * 漏れても写真は開けず、逆も同じにするため。写真は iv / ciphertext / tag を
 * 別カラムで保持するので、結合表現を持つテンプレート側とは戻り値の形も違う。
 *
 * 鍵が未設定なら例外を投げ、呼び出し側 (face-photo-store) が 503 に落とす。
 * 平文写真が DB へ落ちる経路を作らないための fail closed。
 */

import crypto from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../error.js";

export interface FacePhotoCryptoContext {
  userId: string;
  consentId: string;
  mime: string;
}

export interface SealedFacePhoto {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

/** 写真経路が使える状態か (鍵が base64 32 byte で入っているか)。 */
export function isFacePhotoKeyConfigured(): boolean {
  const key = Buffer.from(config.facePhotoStorageKey, "base64");
  const keyId = config.facePhotoKeyId.trim();
  return key.length === 32
    && key.toString("base64") === config.facePhotoStorageKey
    && keyId.length > 0
    && keyId.length <= 128
    && keyId === config.facePhotoKeyId;
}

function photoKey(): Buffer {
  if (!isFacePhotoKeyConfigured()) {
    throw AppError.serviceUnavailable("Face photo storage key is not configured");
  }
  return Buffer.from(config.facePhotoStorageKey, "base64");
}

export function facePhotoKeyId(): string {
  return config.facePhotoKeyId;
}

function aad(context: FacePhotoCryptoContext): Buffer {
  return Buffer.from(
    `face-photo-v1\0${context.userId}\0${context.consentId}\0${context.mime}`,
    "utf8",
  );
}

export function sealFacePhoto(plain: Buffer, context: FacePhotoCryptoContext): SealedFacePhoto {
  const key = photoKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyId: facePhotoKeyId() };
}

export function openFacePhoto(sealed: SealedFacePhoto, context: FacePhotoCryptoContext): Buffer {
  const key = photoKey();
  if (sealed.keyId !== facePhotoKeyId()) {
    throw AppError.serviceUnavailable("Stored face photo key is unavailable");
  }
  if (sealed.iv.length !== 12 || sealed.tag.length !== 16) {
    throw AppError.internal("Stored face photo is malformed");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
