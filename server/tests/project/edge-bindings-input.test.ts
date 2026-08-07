/**
 * edge_idp binding の入力検証。
 *
 * spec/feature/edge-assertion-login.md §10 / §11。 ここで通した値は
 *   - `teamDomain` → JWKS 取得先 と get-identity の宛先 (利用者の CF_Authorization
 *     クッキーを載せる相手)
 *   - `allowedEmailDomains` / `audTags` → 誰のアサーションを受理するか
 *   - `defaultRole` → 自動作成ユーザの system role
 * にそのまま入る。 設定ミスがそのまま認証の穴になるので、 登録時に潰す。
 *
 * db は呼ばれない経路 (parse 失敗) だけを見るため、 接続はスタブにする。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => {
      throw new Error("db must not be reached for rejected input");
    },
    insert: () => {
      throw new Error("db must not be reached for rejected input");
    },
  },
}));

const { registerBinding } = await import("../../src/project/edge-bindings.js");

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectKey: "corp-hub",
    teamDomain: "example.cloudflareaccess.com",
    audTags: ["aud-tag-1"],
    allowedEmailDomains: ["example.co.jp"],
    provisioning: "auto",
    ...overrides,
  };
}

describe("registerBinding — input validation", () => {
  // team_domain は利用者のクッキーを転送する宛先。 任意ホストを許すと binding の
  // 設定ミス 1 つで社外へ転送してしまう。
  it.each([
    ["an attacker-controlled host", "evil.example.com"],
    ["a cloudflareaccess look-alike", "example.cloudflareaccess.com.evil.net"],
    ["a subdomain under the team domain", "a.b.cloudflareaccess.com"],
    ["a URL rather than a host", "https://example.cloudflareaccess.com"],
    ["a host with a port", "example.cloudflareaccess.com:8443"],
    ["a bare team name", "example"],
    ["an empty string", ""],
  ])("rejects teamDomain that is %s", async (_label, teamDomain) => {
    await expect(registerBinding(validPayload({ teamDomain })))
      .rejects.toThrow(/teamDomain/);
  });

  it("rejects an empty allowedEmailDomains list", async () => {
    await expect(registerBinding(validPayload({ allowedEmailDomains: [] })))
      .rejects.toThrow(/allowedEmailDomains/);
  });

  it("rejects an empty audTags list", async () => {
    await expect(registerBinding(validPayload({ audTags: [] })))
      .rejects.toThrow(/audTags/);
  });

  // String(v) で通すと {} が "[object object]" という許可ドメインとして
  // 静かに登録され、 設定ミスが見えなくなる。
  it.each([
    ["allowedEmailDomains", { allowedEmailDomains: ["example.co.jp", {}] }],
    ["audTags", { audTags: [123] }],
    ["adminGroups", { adminGroups: [null] }],
  ])("rejects non-string entries in %s", async (field, overrides) => {
    await expect(registerBinding(validPayload(overrides)))
      .rejects.toThrow(new RegExp(field));
  });

  it.each([
    ["fetchIdentity", "false"],
    ["fetchIdentity", 0],
    ["requireDeviceCheck", "true"],
    ["requireDeviceCheck", 1],
  ])("rejects non-boolean %s", async (field, value) => {
    await expect(registerBinding(validPayload({ [field]: value })))
      .rejects.toThrow(new RegExp(field));
  });

  it("rejects global admin-group mapping until role provenance can be revoked safely", async () => {
    await expect(registerBinding(validPayload({ adminGroups: ["engineering"] })))
      .rejects.toThrow(/role provenance/);
  });

  // 未知の role を入れると「admin でも general でもない」ユーザが出来て
  // 権限判定が静かに壊れる。
  it.each(["superuser", "owner", "root", ""])(
    "rejects defaultRole %j",
    async (defaultRole) => {
      await expect(registerBinding(validPayload({ defaultRole })))
        .rejects.toThrow(/defaultRole/);
    },
  );

  it.each(["", "AUTO", "open", "everyone"])(
    "rejects provisioning %j",
    async (provisioning) => {
      await expect(registerBinding(validPayload({ provisioning })))
        .rejects.toThrow(/provisioning/);
    },
  );

  it.each([
    ["a non-object payload", "corp-hub"],
    ["an array payload", []],
    ["null", null],
  ])("rejects %s", async (_label, payload) => {
    await expect(registerBinding(payload)).rejects.toThrow(/payload must be an object/);
  });

  it("requires projectKey", async () => {
    const { projectKey: _drop, ...rest } = validPayload();
    await expect(registerBinding(rest)).rejects.toThrow(/projectKey/);
  });
});
