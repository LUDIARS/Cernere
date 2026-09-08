/**
 * session key の読み込みと fail-fast (§7.5)。
 *
 * 「無ければ生成」 に降格させないことが要点。 降格すると再起動のたびに全端末の
 * Device Credential が黙って無効になり、 原因不明のログアウトとして現れる。
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { loadSessionKeyMaterial } from "../../src/auth/session-keys.js";

const validKey = randomBytes(32).toString("base64url");

describe("loadSessionKeyMaterial", () => {
  it("正しい鍵と key id を読める", () => {
    const m = loadSessionKeyMaterial({
      CERNERE_AUTH_SESSION_KEY: validKey,
      CERNERE_AUTH_SESSION_KEY_ID: "k1",
    } as NodeJS.ProcessEnv);
    expect(m.keyId).toBe("k1");
    expect(m.master).toHaveLength(32);
  });

  it("鍵が無ければ throw する (生成に降格しない)", () => {
    expect(() => loadSessionKeyMaterial({
      CERNERE_AUTH_SESSION_KEY_ID: "k1",
    } as NodeJS.ProcessEnv)).toThrow(/CERNERE_AUTH_SESSION_KEY/);
  });

  it("key id が無ければ throw する (既定値を持たない)", () => {
    expect(() => loadSessionKeyMaterial({
      CERNERE_AUTH_SESSION_KEY: validKey,
    } as NodeJS.ProcessEnv)).toThrow(/CERNERE_AUTH_SESSION_KEY_ID/);
  });

  it("32 byte でない鍵を拒否する", () => {
    expect(() => loadSessionKeyMaterial({
      CERNERE_AUTH_SESSION_KEY: randomBytes(16).toString("base64url"),
      CERNERE_AUTH_SESSION_KEY_ID: "k1",
    } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
  });
});
