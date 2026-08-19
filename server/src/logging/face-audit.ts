/**
 * 顔写真・顔テンプレート操作の監査記録。
 *
 * 既存の監査台帳 (operation_logs) にそのまま載せる。記録するのは
 * 「誰が・誰に対して・どの施設で・どんな理由で」だけで、
 * **写真バイト / base64 / 埋め込みベクトルは絶対に渡さない**。
 * 失敗しても業務処理は止めず、監査欠落として console に残す (commands.ts と同じ方針)。
 */

import crypto from "node:crypto";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

export type FaceAuditAction =
  | "identity.face_photo.save"
  | "identity.face_photo.read"
  | "identity.face_photo.delete"
  | "identity.face_template.promote"
  | "identity.face_template.reject";

export interface FaceAuditEntry {
  action: FaceAuditAction;
  /** 認証済みの本人 / 職員。 */
  actorUserId?: string;
  /** project service が直接操作した場合の認証済み client identity。 */
  actorServiceId?: string;
  /** service が業務上の担当者として申告した user。認証済み actor とは区別する。 */
  delegatedUserId?: string;
  targetUserId: string;
  facilityId?: string;
  reason?: string;
  status?: "ok" | "error";
  error?: string;
}

export async function recordFaceAudit(entry: FaceAuditEntry): Promise<void> {
  try {
    await db.insert(schema.operationLogs).values({
      id: crypto.randomUUID(),
      userId: entry.actorUserId ?? entry.targetUserId,
      sessionId: "identity:face",
      method: entry.action,
      params: {
        targetUserId: entry.targetUserId,
        facilityId: entry.facilityId ?? null,
        reason: entry.reason ?? null,
        actor: entry.actorUserId
          ? { kind: "user", id: entry.actorUserId }
          : entry.actorServiceId
            ? { kind: "service", id: entry.actorServiceId }
            : null,
        actorServiceId: entry.actorServiceId ?? null,
        delegatedUserId: entry.delegatedUserId ?? null,
      },
      status: entry.status ?? "ok",
      error: entry.error ?? null,
    });
  } catch (err) {
    console.error("[face-audit] insert failed (audit trail at risk):",
      err instanceof Error ? err.name : "unknown");
  }
}
