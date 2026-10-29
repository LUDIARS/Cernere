// 本番配信の静的ファイル (vite preview の置き換え。spec/setup/public-exposure.md)。
//
// 起動時に dist を 1 回だけ列挙して「URL パス → ファイル」の表を作り、要求はこの表と
// 完全一致したものだけを返す。要求から filesystem のパスを組み立てないので、`..`・
// エンコードした区切り・NUL・シンボリックリンクによるトラバーサルは成立しない。
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** URL に載せてよいファイル名 (vite の出力は英数・`-`・`_`・`.` だけ)。それ以外は配らない。 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * dist 配下の通常ファイルを列挙する。シンボリックリンク・隠しファイル・source map・
 * 想定外の文字を含む名前は表に載せない (載らないものは配られない)。
 */
export function buildStaticManifest(distDir) {
  const manifest = new Map();
  const walk = (dir, urlPrefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!SAFE_SEGMENT.test(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(dir, entry.name);
      const urlPath = `${urlPrefix}/${entry.name}`;
      if (entry.isDirectory()) walk(file, urlPath);
      else if (entry.isFile() && extname(entry.name) !== ".map" && CONTENT_TYPES[extname(entry.name).toLowerCase()]) {
        manifest.set(urlPath, { file, size: statSync(file).size, type: CONTENT_TYPES[extname(entry.name).toLowerCase()] });
      }
    }
  };
  walk(distDir, "");
  if (!manifest.has("/index.html")) throw new Error(`index.html is missing in ${distDir}; run the frontend build first`);
  return manifest;
}

/**
 * 要求パス (デコードしない生の pathname) を表から引く。表に無く拡張子も無いパスは
 * SPA の画面として index.html を返し、それ以外は null (404)。
 */
export function lookupStatic(manifest, pathname) {
  const hit = manifest.get(pathname);
  if (hit) return { ...hit, spaFallback: false };
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (pathname.startsWith("/") && !last.includes(".") && !pathname.includes("%")) {
    return { ...manifest.get("/index.html"), spaFallback: true };
  }
  return null;
}

/** ハッシュ付きの /assets/ は長期キャッシュ、 index.html は毎回確認させる。 */
export function cacheControl(pathname, spaFallback) {
  if (spaFallback || pathname.endsWith(".html")) return "no-cache";
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}
