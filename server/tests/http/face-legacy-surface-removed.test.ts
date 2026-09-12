/**
 * 顔テンプレート・顔写真の保存面が残っていないことの回帰テスト。
 *
 * 方針 (顔データは施設 kiosk のローカル正本のみ) は「コードが無い」ことで守るので、
 * 実装が戻ってきたらここで落とす:
 *   - 旧 URL が route 登録されていない (= uWS の fallback で 404)
 *   - face_templates / face_photos を読む / 書くコードが無い
 *   - FACE_TEMPLATE_* / FACE_PHOTO_* / FACE_SIDECAR_URL を config が読まない
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const sources = sourceFiles(SRC_ROOT).map((file) => ({
  file: path.relative(SRC_ROOT, file).replaceAll("\\", "/"),
  text: readFileSync(file, "utf8"),
}));

describe("legacy face template / photo surface", () => {
  it("旧 URL は route 登録されていない", () => {
    const app = sources.find((source) => source.file === "app.ts");
    expect(app).toBeDefined();
    for (const url of [
      "/api/identity/face-template",
      "/api/identity/face-photo",
    ]) {
      expect(app!.text).not.toContain(url);
    }
  });

  it("face_templates / face_photos を読む・書くコードが無い", () => {
    const offenders = sources.filter((source) => /faceTemplates|facePhotos|faceTemplateTombstones|face_templates|face_photos/.test(source.text));
    expect(offenders.map((source) => source.file)).toEqual([]);
  });

  it("生体情報の鍵・sidecar の env を読まない", () => {
    const offenders = sources.filter((source) => /FACE_TEMPLATE_|FACE_PHOTO_|FACE_SIDECAR_/.test(source.text));
    expect(offenders.map((source) => source.file)).toEqual([]);
  });

  it("テンプレート・写真の封緘モジュールが存在しない", () => {
    const removed = [
      "identity/face-template-store.ts",
      "identity/face-template-crypto.ts",
      "identity/face-template-versioning.ts",
      "identity/face-photo-store.ts",
      "identity/face-photo-crypto.ts",
      "identity/face-photo-image.ts",
      "identity/face-photo-deletion.ts",
      "identity/face-photo-consent.ts",
      "identity/face-sidecar-client.ts",
      "http/face-template-handler.ts",
      "http/face-photo-handler.ts",
    ];
    expect(sources.filter((source) => removed.includes(source.file)).map((s) => s.file)).toEqual([]);
  });
});
