import { describe, expect, it } from "vitest";
import {
  clearPendingDisplayName,
  normalizeDisplayName,
  savePendingDisplayName,
  takePendingDisplayName,
} from "../../../frontend/src/lib/pending-display-name";
import { startUrl } from "../../../frontend/src/pages/onboarding/onboarding-return";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
}

describe("「はじめる」前の名前の受け渡し", () => {
  it("空白を除き、空や長すぎる名前は受け付けない", () => {
    expect(normalizeDisplayName("  ねこ ")).toBe("ねこ");
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("a".repeat(81))).toBeNull();
  });

  it("保存した名前を作成後に取り出し、消せる", () => {
    const storage = memoryStorage();
    savePendingDisplayName("ねこ", storage);
    expect(takePendingDisplayName(storage)).toBe("ねこ");
    clearPendingDisplayName(storage);
    expect(takePendingDisplayName(storage)).toBeNull();
  });

  it("保存先が使えない環境では null (名前入力にフォールバック)", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => savePendingDisplayName("ねこ", broken)).not.toThrow();
    expect(takePendingDisplayName(broken)).toBeNull();
    expect(takePendingDisplayName(null)).toBeNull();
  });
});

describe("startUrl (はじめての方の入口)", () => {
  it("戻り先を Cernere 内のパスに限って /start に付ける", () => {
    expect(startUrl("/composite/login?origin=x")).toBe("/start?return=%2Fcomposite%2Flogin%3Forigin%3Dx");
    expect(startUrl("https://evil.example/")).toBe("/start?return=%2F");
  });
});
