/**
 * Discord interaction の署名検証 (Ed25519)。
 * 署名対象は `timestamp + rawBody`。公開鍵は Discord アプリの 32 byte 公開鍵 (hex)。
 * タイムスタンプが古すぎる (既定 5 分) ものは再送とみなして拒否する。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import crypto from "node:crypto";

/** Ed25519 の生公開鍵 (32 byte) を SPKI DER にするための接頭辞。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const DISCORD_SIGNATURE_MAX_AGE_SEC = 300;

export interface DiscordSignatureInput {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: string;
  nowSec?: number;
}

export function verifyDiscordSignature(input: DiscordSignatureInput): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = input;
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{1,12}$/.test(timestamp)) return false;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > DISCORD_SIGNATURE_MAX_AGE_SEC) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(timestamp + rawBody, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
