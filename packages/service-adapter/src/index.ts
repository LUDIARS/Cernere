/**
 * @cernere/service-adapter
 *
 * サービスが Cernere の3点方式認証に参加するためのアダプタパッケージ。
 *
 * ## 使い方
 *
 * ```typescript
 * import { CernereServiceAdapter, createServiceAuthMiddleware } from "@cernere/service-adapter";
 *
 * // 1. アダプタを作成して Cernere に接続
 * const adapter = new CernereServiceAdapter({
 *   cernereWsUrl: "ws://cernere:8080/ws/service",
 *   serviceCode: "schedula",
 *   serviceSecret: process.env.CERNERE_SERVICE_SECRET!,
 *   jwtSecret: process.env.SERVICE_JWT_SECRET!,
 * }, {
 *   onUserAdmission: async (user, orgId, scopes) => {
 *     // ユーザーデータをローカル DB に保存
 *     await userRepo.upsertFromCernere(user);
 *   },
 *   onUserRevoke: async (userId) => {
 *     // ローカルセッションを破棄
 *     await sessionStore.revokeByUserId(userId);
 *   },
 * });
 * adapter.connect();
 *
 * // 2. Hono ミドルウェアで service_token を検証
 * app.use("/api/*", createServiceAuthMiddleware({
 *   adapter,
 *   jwtSecret: process.env.SERVICE_JWT_SECRET!,
 * }));
 * ```
 */

// Core adapter
export { CernereServiceAdapter } from "./adapter.js";

// Hono middleware
export { createServiceAuthMiddleware } from "./middleware.js";

// Types
export type {
  ServiceAdapterConfig,
  ServiceAdapterCallbacks,
  AdmittedUser,
  CernereMessage,
  ServiceAuthenticatedMsg,
  UserAdmissionMsg,
  UserRevokeMsg,
} from "./types.js";
