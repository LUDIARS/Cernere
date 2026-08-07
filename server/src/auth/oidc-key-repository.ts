/**
 * oidc_signing_keys テーブルへのアクセス (migration 039)。
 *
 * `private_key_pem` は秘密鍵なので、 users.google_* / project OAuth トークンと
 * 同じ規律で保存時暗号化する (`encryptSecret()` / `decryptSecret()`、 RULE.md §7.2)。
 * `decryptSecret()` の移行シムにより、 暗号化導入前に書かれた平文行もそのまま読める。
 * `CERNERE_SECRET_KEY` 未設定時は `encryptSecret()` が throw する (fail-closed、
 * 平文フォールバック無し)。 呼び出し側 (oidc-keys.ts) はこれを「鍵ストア利用不可」
 * として OIDC 無効化に落とす。
 *
 * 仕様: spec/feature/oidc-provider.md §1.1
 */

import { and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { oidcSigningKeys } from "../db/schema.js";
import { encryptSecret, decryptSecret } from "../lib/crypto/secret-box.js";

export interface OidcStoredSigningKey {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
  isCurrent: boolean;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface OidcKeyRepository {
  findCurrent(): Promise<OidcStoredSigningKey | null>;
  findRetiredSince(since: Date): Promise<OidcStoredSigningKey[]>;
  insertCurrent(key: Pick<OidcStoredSigningKey, "kid" | "privateKeyPem" | "publicKeyPem">): Promise<void>;
}

function toStoredKey(row: typeof oidcSigningKeys.$inferSelect): OidcStoredSigningKey {
  return {
    kid: row.kid,
    privateKeyPem: decryptSecret(row.privateKeyPem),
    publicKeyPem: row.publicKeyPem,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt,
    retiredAt: row.retiredAt,
  };
}

export const oidcKeyRepository: OidcKeyRepository = {
  async findCurrent(): Promise<OidcStoredSigningKey | null> {
    const rows = await db.select().from(oidcSigningKeys)
      .where(eq(oidcSigningKeys.isCurrent, true)).limit(1);
    return rows[0] ? toStoredKey(rows[0]) : null;
  },

  async findRetiredSince(since: Date): Promise<OidcStoredSigningKey[]> {
    const rows = await db.select().from(oidcSigningKeys).where(and(
      isNotNull(oidcSigningKeys.retiredAt),
      gt(oidcSigningKeys.retiredAt, since),
    ));
    const keys: OidcStoredSigningKey[] = [];
    for (const row of rows) {
      try {
        keys.push(toStoredKey(row));
      } catch {
        // A retired key is verification-only. One corrupt historical row must
        // not hide every other valid retired key or disable the current signer.
        console.warn(`[oidc] skipping unreadable retired key kid=${row.kid}`);
      }
    }
    return keys;
  },

  async insertCurrent(key): Promise<void> {
    await db.insert(oidcSigningKeys).values({
      kid: key.kid,
      privateKeyPem: encryptSecret(key.privateKeyPem),
      publicKeyPem: key.publicKeyPem,
      isCurrent: true,
    });
  },
};
