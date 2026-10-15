import { describe, expect, it } from "vitest";
import { passkeyAbortOutcome } from "../../../packages/composite/src/ui/passkey-continue";

describe("passkeyAbortOutcome (パスキーの入口を 1 つに)", () => {
  it("自分で押してパスキーが無かったときだけ作成へ進む", () => {
    expect(passkeyAbortOutcome({ manual: true, canCreate: true })).toBe("create");
  });

  it("画面を開いた直後の自動起動が取消で終わっても作成ダイアログは出さない", () => {
    expect(passkeyAbortOutcome({ manual: false, canCreate: true })).toBe("fallback");
  });

  it("作成の導線が無い埋め込み先では再試行の案内に戻る", () => {
    expect(passkeyAbortOutcome({ manual: true, canCreate: false })).toBe("fallback");
  });
});
