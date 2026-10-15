import { describe, expect, it } from "vitest";
import { toAuthUser } from "../../../frontend/src/lib/me-user";

describe("toAuthUser (/api/auth/me → ログイン中ユーザー)", () => {
  it("サーバーが name で返す表示名を拾う (displayName を読んで空になりオンボーディングがループした回帰)", () => {
    const user = toAuthUser({ id: "u1", name: "ねこ", email: null, role: "general" });
    expect(user).toEqual({ id: "u1", name: "ねこ", email: "", role: "general" });
  });

  it("名前が未設定 (null) なら空文字にしてオンボーディングへ回せる", () => {
    expect(toAuthUser({ id: "u2", name: null, email: "a@example.invalid", role: "general" }).name).toBe("");
  });

  it("空白だけの名前は未設定として扱う", () => {
    expect(toAuthUser({ id: "u3", name: "   ", email: null, role: "general" }).name).toBe("");
  });
});
