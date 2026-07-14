#!/usr/bin/env tsx
/**
 * Ed25519 keypair を生成し、 base64 文字列で stdout に出す。
 * `.env` / Infisical に貼る用の 1 回切りスクリプト。
 *
 * 使い方:
 *   npx tsx scripts/generate-paseto-keypair.ts
 *
 * 出力:
 *   CERNERE_PASETO_SECRET_KEY=<base64 of 32-byte seed>
 *   CERNERE_PASETO_PUBLIC_KEY=<base64 of 32-byte raw>
 *   CERNERE_PASETO_KID=v1
 *
 * 秘密鍵は Cernere の secret store にのみ置く (Hub には絶対に置かない)。
 * 公開鍵は GET /.well-known/cernere-public-key で公開される。
 */

import { generateKeyPairSync } from "node:crypto";

function main(): void {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  // pkcs8 形式の Ed25519 private key は ASN.1 ヘッダ後の末尾 32 byte が seed。
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const secretSeed = privateDer.subarray(privateDer.length - 32);

  // spki 形式の Ed25519 public key も末尾 32 byte が raw key。
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicRaw = publicDer.subarray(publicDer.length - 32);

  console.log("# Cernere PASETO v4 keypair (Ed25519)");
  console.log("# Generated:", new Date().toISOString());
  console.log("# ");
  console.log("# 以下を Cernere の secret store (Infisical / .env) に貼ってください。");
  console.log("# SECRET_KEY は絶対に Hub 側には置かないこと。 PUBLIC_KEY は誰でも fetch 可。");
  console.log("");
  console.log(`CERNERE_PASETO_SECRET_KEY=${secretSeed.toString("base64")}`);
  console.log(`CERNERE_PASETO_PUBLIC_KEY=${publicRaw.toString("base64")}`);
  console.log(`CERNERE_PASETO_KID=v1`);
}

main();
