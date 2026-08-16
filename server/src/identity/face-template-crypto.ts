import crypto from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../error.js";

export interface FaceTemplateCryptoContext {
  userId: string;
  facilityId: string;
  modelId: string;
  version: number;
}

function decodeBase64Key(encoded: string, error: AppError): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw error;
  return key;
}

function storageKey(): Buffer {
  return decodeBase64Key(
    config.faceTemplateStorageKey,
    AppError.internal("FACE_TEMPLATE_STORAGE_KEY must be a base64 32-byte key"),
  );
}

function distributionKey(facilityId: string): Buffer {
  let keys: unknown;
  try {
    keys = JSON.parse(config.faceTemplateDistributionKeys);
  } catch {
    throw AppError.internal("FACE_TEMPLATE_DISTRIBUTION_KEYS must be valid JSON");
  }
  const encoded = typeof keys === "object" && keys !== null
    ? (keys as Record<string, unknown>)[facilityId]
    : undefined;
  if (typeof encoded !== "string") {
    throw AppError.forbidden("No distribution key is configured for this facility");
  }
  return decodeBase64Key(
    encoded,
    AppError.forbidden("No valid distribution key is configured for this facility"),
  );
}

function storageAad(context: FaceTemplateCryptoContext): Buffer {
  return Buffer.from(
    `face-template-v1\0${context.userId}\0${context.facilityId}\0${context.modelId}\0${context.version}`,
    "utf8",
  );
}

function seal(plain: Buffer, key: Buffer, aad?: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(sealed: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (sealed.length < 29) throw AppError.internal("Stored face template is malformed");
  const cipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  cipher.setAAD(aad);
  cipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([cipher.update(sealed.subarray(12, -16)), cipher.final()]);
}

export function sealStoredFaceTemplate(plain: Buffer, context: FaceTemplateCryptoContext): Buffer {
  return seal(plain, storageKey(), storageAad(context));
}

export function openStoredFaceTemplate(sealed: Buffer, context: FaceTemplateCryptoContext): Buffer {
  return open(sealed, storageKey(), storageAad(context));
}

export function createFaceTemplateDistributor(facilityId: string): {
  keyId: string;
  seal: (plain: Buffer) => Buffer;
} {
  const key = distributionKey(facilityId);
  return {
    keyId: `facility:${facilityId}:v1`,
    seal: (plain) => seal(plain, key),
  };
}
