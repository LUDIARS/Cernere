/**
 * セキュリティ上の出来事の記録 (SPEC-LOGIN-ALERT)。
 *
 * 出来事を起こした処理と同じトランザクションで security_events と notification_outbox に積む。
 * 配送は notify/outbox-worker.ts が行い、送信失敗で元の処理 (ログイン等) を止めない。
 * 宛先は記録した時点の確認済み通知先で固定する (通知先を変えた直後の出来事も旧宛先へ届く)。
 */

import crypto from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

export type SecurityEventKind =
  | "session.new"
  | "passkey.pairing_requested"
  | "passkey.added"
  | "passkey.removed"
  | "recovery.requested"
  | "recovery.cancelled"
  | "recovery.completed"
  | "recovery.code_reissued"
  | "recovery.operator"
  | "session.revoke_all"
  | "alert_target.added"
  | "alert_target.removed"
  | "access.approved"
  | "access.rejected"
  | "access.locked"
  | "access.unlocked"
  | "access.requests_pending"
  | "federation.joined"
  | "federation.left"
  | "federation.primary_changed";

export type SecuritySeverity = "normal" | "high" | "critical";

const SEVERITY: Record<SecurityEventKind, SecuritySeverity> = {
  "session.new": "normal",
  "passkey.pairing_requested": "high",
  "passkey.added": "high",
  "passkey.removed": "high",
  "recovery.requested": "critical",
  "recovery.cancelled": "high",
  "recovery.completed": "critical",
  "recovery.code_reissued": "high",
  "recovery.operator": "critical",
  "session.revoke_all": "high",
  "alert_target.added": "high",
  "alert_target.removed": "high",
  "access.approved": "normal",
  "access.rejected": "high",
  "access.locked": "critical",
  "access.unlocked": "high",
  "access.requests_pending": "normal",
  "federation.joined": "high",
  "federation.left": "high",
  "federation.primary_changed": "high",
};

/** 通知に載せてよい概略だけ。秘密値・token・完全な IP・userId・メールは入れない。 */
export interface SecurityEventDetail {
  device?: string;
  country?: string;
  eligibleAt?: string;
  channel?: string;
  /** 審査待ちの件数 (admin 向けのまとめ通知) */
  count?: number;
}

type Database = Pick<typeof db, "select" | "insert">;

export interface RecordedSecurityEvent {
  id: string;
  kind: SecurityEventKind;
  severity: SecuritySeverity;
}

/** 出来事を記録し、本人の他セッション (relay) と確認済みの通知先への配送を積む。 */
export async function recordSecurityEvent(
  database: Database,
  userId: string,
  kind: SecurityEventKind,
  detail: SecurityEventDetail = {},
): Promise<RecordedSecurityEvent> {
  const id = crypto.randomUUID();
  const severity = SEVERITY[kind];
  await database.insert(schema.securityEvents).values({ id, userId, kind, severity, detail });

  const targets = await database.select({
    channel: schema.loginAlertTargets.channel,
    address: schema.loginAlertTargets.address,
  }).from(schema.loginAlertTargets).where(and(
    eq(schema.loginAlertTargets.userId, userId),
    isNotNull(schema.loginAlertTargets.verifiedAt),
    isNull(schema.loginAlertTargets.removedAt),
  ));

  const rows = [
    { channel: "relay", targetRef: userId },
    ...targets.map((t) => ({ channel: t.channel, targetRef: t.address })),
  ];
  await database.insert(schema.notificationOutbox).values(rows.map((row) => ({
    id: crypto.randomUUID(),
    eventId: id,
    channel: row.channel,
    targetRef: row.targetRef,
  })));
  return { id, kind, severity };
}

/** 通知先を外す出来事は、外す前の宛先にも届ける。外す処理より前に呼ぶ。 */
export async function recordBeforeTargetRemoval(
  database: Database,
  userId: string,
  channel: "discord" | "google",
): Promise<RecordedSecurityEvent> {
  return recordSecurityEvent(database, userId, "alert_target.removed", { channel });
}
