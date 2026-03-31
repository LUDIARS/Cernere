/**
 * @cernere/id-cache — 組み込み用キャッシュパッケージ
 *
 * Id Service のユーザー情報をローカルキャッシュし、
 * JWT 検証 + ユーザー解決を高速化する。
 *
 * なくても動作する: キャッシュがない場合は毎回 Id Service API を呼ぶ。
 *
 * Usage:
 *   const cache = createIdCache({ idServiceUrl: "http://localhost:8079" });
 *   app.use("/api/*", cache.middleware());
 *   // c.get("userId"), c.get("userRole") が使える
 */

export { createIdCache } from "./cache.js";
export type { IdCacheConfig, IdCacheClient, CachedUser } from "./cache.js";
export { createIdCacheMiddleware } from "./middleware.js";
export type { IdCacheMiddlewareOptions } from "./middleware.js";
