/**
 * REST export エンドポイント共通の認可チェック。
 *
 * admin 限定 (CONTRACTS.md §2)。 2 経路を許す:
 *   1. user accessToken で `users.role === 'admin'` のユーザ (運用者の手動取得)
 *   2. project token (= service-to-service Bearer。 Ostiarius の CERNERE_SERVICE_TOKEN 等)
 * どちらも満たさなければ 401/403。
 *
 * 元々 passkey-handler.ts の bulk export 用に private 実装されていたが、
 * project schema export (Foedus 向け) など他の export ルートからも同じ
 * 認可ポリシーが必要になったため共有モジュールへ切り出した。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { verifyToken, verifyProjectToken, extractBearerToken } from "../auth/jwt.js";
import { isCurrentProjectCredential } from "../project/project-credential-state.js";

export async function requireExportAuth(authHeader: string): Promise<void> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: missing bearer token");

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
    if (!current) throw new Error("Unauthorized: project credential is inactive or rotated");
    return; // 有効な project token = service 認証成立
  }

  // (1) user: accessToken を検証し、 DB の role が admin かを確認
  const payload = verifyToken(token);
  if (typeof payload.sub !== "string") throw new Error("Unauthorized: invalid token");
  const rows = await db.select({ role: schema.users.role })
    .from(schema.users).where(eq(schema.users.id, payload.sub)).limit(1);
  if (rows[0]?.role !== "admin") throw new Error("Forbidden: admin required");
}
