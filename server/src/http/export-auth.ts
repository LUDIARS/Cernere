/**
 * REST export エンドポイント共通の認可チェック。
 *
 * admin 限定 (CONTRACTS.md §2)。 2 経路を許す:
 *   1. user accessToken で `users.role === 'admin'` のユーザ (運用者の手動取得)
 *   2. project token (= service-to-service Bearer。 Ostiarius の CERNERE_SERVICE_TOKEN 等) で、
 *      呼出元 project が要求 scope を service_scopes に宣言しているもの (管理者所有、毎回 DB で判定)
 * どちらも満たさなければ 401/403。
 *
 * 以前は「有効な project token なら何でも」通していたため、どのサービスの client_secret でも
 * 全利用者の passkey 公開鍵・名簿・スキーマを引けた (2026-10-29 の点検)。
 *
 * 元々 passkey-handler.ts の bulk export 用に private 実装されていたが、
 * project schema export (Foedus 向け) など他の export ルートからも同じ
 * 認可ポリシーが必要になったため共有モジュールへ切り出した。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { verifyToken, verifyProjectToken, extractBearerToken } from "../auth/jwt.js";
import { AppError } from "../error.js";
import { isCurrentProjectCredential } from "../project/project-credential-state.js";
import { declaredServiceScopes } from "../project/service-scopes.js";

/** export 系の口ごとの scope (project の service_scopes に宣言する)。 */
export const EXPORT_SCOPES = {
  passkeyExport: "passkey:export",
  identityRoster: "identity-roster:read",
  projectSchema: "project-schema:read",
  kioskCodeExchange: "auth-code:kiosk-exchange",
} as const;
export type ExportScope = typeof EXPORT_SCOPES[keyof typeof EXPORT_SCOPES];

export type ExportPrincipal =
  | { kind: "project"; subject: string; projectKey: string }
  | { kind: "admin"; subject: string };

export async function requireExportAuth(authHeader: string, scope: ExportScope): Promise<ExportPrincipal> {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Unauthorized: missing bearer token");

  // (2) service: project token (project_credentials 由来) を先に試す。
  // 署名が通っても、無効化されたプロジェクトや rotate 済みの世代は拒否する
  // (WebSocket upgrade と同じ判定を isCurrentProjectCredential で共有)。
  let projectClaims: ReturnType<typeof verifyProjectToken> | null = null;
  try { projectClaims = verifyProjectToken(token); }
  catch { /* user token として再評価 */ }
  if (projectClaims) {
    const current = await isCurrentProjectCredential(
      projectClaims.sub,
      projectClaims.projectKey,
      projectClaims.credentialGeneration ?? 0,
    );
    if (!current) throw AppError.unauthorized("Unauthorized: project credential is inactive or rotated");
    const rows = await db.select({ schemaDefinition: schema.managedProjects.schemaDefinition })
      .from(schema.managedProjects).where(eq(schema.managedProjects.clientId, projectClaims.sub)).limit(1);
    if (!declaredServiceScopes(rows[0]?.schemaDefinition).includes(scope)) {
      throw AppError.forbidden(`Forbidden: scope ${scope} is required`);
    }
    return {
      kind: "project",
      subject: projectClaims.sub,
      projectKey: projectClaims.projectKey,
    };
  }

  // (1) user: accessToken を検証し、 DB の role が admin かを確認
  const payload = await verifyToken(token);
  if (typeof payload.sub !== "string") throw AppError.unauthorized("Unauthorized: invalid bearer token");
  const rows = await db.select({ role: schema.users.role })
    .from(schema.users).where(eq(schema.users.id, payload.sub)).limit(1);
  if (rows[0]?.role !== "admin") throw AppError.forbidden("Forbidden: admin role is required");
  return { kind: "admin", subject: payload.sub };
}
