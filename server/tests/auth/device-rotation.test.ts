/**
 * Device Credential のローテーション判定
 * (spec/plan/passkey-default-authentication.md §11.3 / §11.4)
 *
 * 競合と応答消失は実運用で最も再現しにくい経路なので、 純関数として切り出した
 * 判定をここで網羅する。 「旧 token が来た = 盗用」 と決め打つと、 二重起動や
 * 通信断でユーザーを締め出すため、 その境界を重点的に見る。
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ROTATION_GRACE_MS,
  decideRotation,
  type DeviceCredentialState,
  type RotationKeys,
} from "../../src/auth/device-rotation.js";
import { computeSecretHash, deriveNextSecret, deriveSubkey } from "../../src/auth/session-keys.js";
import { DEVICE_TOKEN_PREFIX } from "../../src/auth/device-token.js";

const master = randomBytes(32);
const keys: RotationKeys = {
  verifyKey: deriveSubkey(master, "device/verify"),
  rotateKey: deriveSubkey(master, "device/rotate"),
};

const DEVICE_ID = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-08-21T00:00:00.000Z");

function hashOf(secret: string): string {
  return computeSecretHash(keys.verifyKey, DEVICE_TOKEN_PREFIX, DEVICE_ID, secret);
}

function state(over: Partial<DeviceCredentialState> = {}): DeviceCredentialState {
  return {
    id: DEVICE_ID,
    generation: 3,
    currentSecretHash: hashOf("current-secret"),
    previousSecretHash: null,
    previousValidUntil: null,
    lastRotationId: null,
    lastRotatedAt: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    ...over,
  };
}

function decide(
  s: DeviceCredentialState,
  presentedSecret: string,
  rotationId = "rot-a",
  now = NOW,
) {
  return decideRotation(s, { presentedSecret, rotationId, now }, keys);
}

describe("decideRotation — 正常系", () => {
  it("現行 secret で次世代を発行する", () => {
    const d = decide(state(), "current-secret");
    expect(d.kind).toBe("rotate");
    if (d.kind !== "rotate") return;
    expect(d.nextGeneration).toBe(4);
    // 保存されるのはハッシュだけ。 導出した secret と整合していること。
    expect(d.nextSecretHash).toBe(hashOf(d.secret));
    expect(d.previousValidUntil.getTime()).toBe(NOW.getTime() + ROTATION_GRACE_MS);
  });

  it("同じ rotation_id なら同じ次世代 secret を再現する", () => {
    // raw token を DB に置かずに冪等性を得るための性質。
    const a = decide(state(), "current-secret", "rot-x");
    const b = decide(state(), "current-secret", "rot-x");
    expect(a.kind).toBe("rotate");
    expect(b.kind).toBe("rotate");
    if (a.kind !== "rotate" || b.kind !== "rotate") return;
    expect(a.secret).toBe(b.secret);
  });

  it("rotation_id が違えば別の secret になる", () => {
    const a = decide(state(), "current-secret", "rot-x");
    const b = decide(state(), "current-secret", "rot-y");
    if (a.kind !== "rotate" || b.kind !== "rotate") return;
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("decideRotation — 正常競合", () => {
  it("直近 grace 内に回った行へ現行 secret が来たら世代を進めない", () => {
    // 別タブが今しがた回した直後。 ここで更に回すと、 新 token をまだ保存できて
    // いない他タブを弾いてしまう。
    const d = decide(state({ lastRotatedAt: new Date(NOW.getTime() - 1_000) }), "current-secret");
    expect(d.kind).toBe("keep");
    if (d.kind !== "keep") return;
    expect(d.secret).toBe("current-secret");
  });

  it("grace を過ぎていれば現行 secret で通常どおり回す", () => {
    const d = decide(
      state({ lastRotatedAt: new Date(NOW.getTime() - ROTATION_GRACE_MS - 1) }),
      "current-secret",
    );
    expect(d.kind).toBe("rotate");
  });
});

describe("decideRotation — 応答消失の再送", () => {
  // 現行世代の secret は乱数ではなく (device_id, generation, rotation_id) からの
  // 導出値。 replay の再生成が成り立つのはこの性質による。
  const gen4Secret = deriveNextSecret(keys.rotateKey, DEVICE_ID, 4, "rot-a");
  const rotated = state({
    generation: 4,
    currentSecretHash: hashOf(gen4Secret),
    previousSecretHash: hashOf("current-secret"),
    previousValidUntil: new Date(NOW.getTime() + ROTATION_GRACE_MS),
    lastRotationId: "rot-a",
    lastRotatedAt: NOW,
  });

  it("旧 secret + 同じ rotation_id は現行世代を再生成して成功で返す", () => {
    // 「サーバーは更新済みだがクライアントが応答を受け取れなかった」 を吸収する。
    const d = decide(rotated, "current-secret", "rot-a");
    expect(d.kind).toBe("replay");
    if (d.kind !== "replay") return;
    // 再生成した secret が、 DB に入っている現行ハッシュと一致すること。
    expect(hashOf(d.secret)).toBe(rotated.currentSecretHash);
  });

  it("旧 secret + 別の rotation_id は失効させず 409 にする", () => {
    const d = decide(rotated, "current-secret", "rot-b");
    expect(d).toEqual({ kind: "error", code: "DEVICE_ROTATION_CONFLICT" });
  });

  it("grace を過ぎた旧 secret はパスキーへ戻す", () => {
    const d = decide(
      rotated,
      "current-secret",
      "rot-a",
      new Date(NOW.getTime() + ROTATION_GRACE_MS + 1),
    );
    expect(d).toEqual({ kind: "error", code: "PASSKEY_REQUIRED" });
  });
});

describe("decideRotation — 拒否", () => {
  it("未知の secret はパスキーへ戻す", () => {
    expect(decide(state(), "unknown")).toEqual({ kind: "error", code: "PASSKEY_REQUIRED" });
  });

  it("失効済みの行は REVOKED", () => {
    expect(decide(state({ revokedAt: NOW }), "current-secret"))
      .toEqual({ kind: "error", code: "DEVICE_CREDENTIAL_REVOKED" });
  });

  it("期限切れの行は EXPIRED", () => {
    expect(decide(state({ expiresAt: NOW }), "current-secret"))
      .toEqual({ kind: "error", code: "DEVICE_CREDENTIAL_EXPIRED" });
  });

  it("失効判定は secret の正しさより先に効く", () => {
    // 失効済みの行に正しい secret が来ても通してはいけない。
    expect(decide(state({ revokedAt: NOW }), "current-secret").kind).toBe("error");
  });
});

describe("鍵のドメイン分離", () => {
  it("verify 鍵と rotate 鍵は別物になる", () => {
    expect(deriveSubkey(master, "device/verify").equals(deriveSubkey(master, "device/rotate")))
      .toBe(false);
  });

  it("device と email で同じ用途でも鍵が分かれる", () => {
    expect(deriveSubkey(master, "device/verify").equals(deriveSubkey(master, "email/verify")))
      .toBe(false);
  });

  it("master が違えば別の hash になる", () => {
    const other = deriveSubkey(randomBytes(32), "device/verify");
    expect(computeSecretHash(other, DEVICE_TOKEN_PREFIX, DEVICE_ID, "s"))
      .not.toBe(hashOf("s"));
  });
});
