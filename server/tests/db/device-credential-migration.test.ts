/**
 * migration 050-052 の内容検査。
 *
 * DDL は実 DB を立てずに読めるので、 CLAUDE.md §2 の禁止事項 (DROP TABLE /
 * DROP COLUMN / ALTER COLUMN TYPE / 番号重複) と、 仕様が要求する制約が
 * 落ちていないことを静的に見る。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

const device = migration("050_device_credentials.sql");
const grants = migration("051_registration_grants.sql");
const epoch = migration("052_auth_epoch_and_passkey_revocation.sql");

describe("050 device_credentials", () => {
  it("id を主キーにし user へ CASCADE で紐づける", () => {
    expect(device).toContain("CREATE TABLE IF NOT EXISTS device_credentials");
    expect(device).toContain("id                       UUID PRIMARY KEY");
    expect(device).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  });

  it("root_passkey_id は SET NULL にする", () => {
    // ここを CASCADE にすると、 passkey を消したときに端末行ごと消えて
    // 監査 (どの passkey 由来だったか) が追えなくなる。
    expect(device).toMatch(/root_passkey_id\s+UUID REFERENCES passkeys\(id\) ON DELETE SET NULL/);
  });

  it("client_kind を browser / native に限定する", () => {
    // OS / UA / 自由入力ラベルを保存しない (§6.2) ための制約。
    expect(device).toContain("CHECK (client_kind IN ('browser', 'native'))");
  });

  it("secret 本体ではなくハッシュ列を持つ", () => {
    expect(device).toContain("current_secret_hash");
    expect(device).toContain("previous_secret_hash");
    expect(device).not.toMatch(/\bsecret\s+TEXT\b/);
  });

  it("ローテーション競合の判定に必要な列が揃っている", () => {
    for (const col of [
      "generation", "previous_valid_until", "last_rotation_id", "last_rotated_at",
    ]) {
      expect(device).toContain(col);
    }
  });

  it("revoked_reason を仕様の集合に限定する", () => {
    for (const reason of [
      "logout", "replay", "admin", "recovery", "passkey_revoked", "key_rotation", "expired",
    ]) {
      expect(device).toContain(`'${reason}'`);
    }
  });

  it("生存行だけの部分インデックスを張る", () => {
    expect(device).toMatch(/CREATE INDEX IF NOT EXISTS idx_device_credentials_user_active[\s\S]*WHERE revoked_at IS NULL/);
  });
});

describe("051 registration_grants", () => {
  it("purpose を 4 種に限定する", () => {
    for (const p of ["bootstrap", "create_user", "recover_user", "email_enroll"]) {
      expect(grants).toContain(`'${p}'`);
    }
  });

  it("token 本体ではなく hash を UNIQUE で持つ", () => {
    expect(grants).toContain("token_hash         TEXT NOT NULL UNIQUE");
    expect(grants).not.toMatch(/\btoken\s+TEXT\b/);
  });

  it("失効範囲を発行時点で固定する列を持つ", () => {
    // client に失効範囲を変えさせないための指定 (§12.2)。
    expect(grants).toContain("revoke_passkey_ids");
    expect(grants).toContain("revoke_all_existing_passkeys");
  });

  it("purpose と subject の組み合わせを CHECK で縛る", () => {
    expect(grants).toContain("CONSTRAINT chk_registration_grant_subject");
    expect(grants).toMatch(/pending_user_id IS NOT NULL/);
    expect(grants).toMatch(/subject_user_id IS NOT NULL/);
  });

  it("pending_user_id を FK にしない", () => {
    // finish transaction が作る「まだ存在しない user」 を指すため。
    expect(grants).not.toMatch(/pending_user_id\s+UUID REFERENCES/);
  });
});

describe("052 auth_epoch / passkey 論理失効", () => {
  it("users へ webauthn_user_id と auth_epoch を足す", () => {
    expect(epoch).toContain("ADD COLUMN IF NOT EXISTS webauthn_user_id TEXT");
    expect(epoch).toContain("ADD COLUMN IF NOT EXISTS auth_epoch BIGINT NOT NULL DEFAULT 0");
  });

  it("webauthn_user_id は NULL を許す部分 UNIQUE にする", () => {
    // 全 user に一斉付与しないので、 単純 UNIQUE だと NULL 以外で衝突する前に
    // backfill 対象外の行を扱えない。
    expect(epoch).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_users_webauthn_user_id[\s\S]*WHERE webauthn_user_id IS NOT NULL/);
  });

  it("passkeys へ discoverable と revoked_at を足す", () => {
    expect(epoch).toContain("ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT false");
    expect(epoch).toContain("ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ");
  });

  it("既存 passkey 保有者の user handle だけ backfill する", () => {
    // 既存ユーザの user handle を変えると、 登録済みパスキーが自分のものだと
    // 認識されなくなる。 対象を EXISTS で絞っていること。
    expect(epoch).toMatch(/UPDATE users u[\s\S]*SET webauthn_user_id/);
    expect(epoch).toMatch(/EXISTS \(SELECT 1 FROM passkeys p WHERE p\.user_id = u\.id\)/);
    expect(epoch).toContain("WHERE u.webauthn_user_id IS NULL");
  });

  it("discoverable の既定は false (安全側)", () => {
    expect(epoch).not.toContain("discoverable BOOLEAN NOT NULL DEFAULT true");
  });
});

describe("CLAUDE.md §2 の禁止事項", () => {
  it("破壊的 DDL を含まない", () => {
    for (const sql of [device, grants, epoch]) {
      expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
      expect(sql).not.toMatch(/ALTER COLUMN\s+\w+\s+TYPE/i);
    }
  });

  it("冪等な書き方になっている", () => {
    expect(device).toContain("CREATE TABLE IF NOT EXISTS");
    expect(grants).toContain("CREATE TABLE IF NOT EXISTS");
    expect(epoch).toContain("ADD COLUMN IF NOT EXISTS");
  });
});
