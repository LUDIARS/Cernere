/**
 * user_service_consents / consent_decisions の読み書き (設計書 §5.1)。
 *
 * 同意は利用者 × サービスに 1 行。判断のたびに consent_decisions へ追記する (監査)。
 * 推奨の拒否を user_data_optouts へ反映するのは denial-sync.ts の担当。
 */

import { and, eq } from "drizzle-orm";
import { db, type Database } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type { ConsentRecordState } from "./requirement.js";

export type ConsentSubjectKind = "project" | "oidc_client";

export interface ConsentSubject {
  kind: ConsentSubjectKind;
  /** managed_projects.key / oidc_clients.client_id */
  key: string;
}

export type ConsentAction = "grant" | "deny" | "revoke" | "update";

export interface StoredConsent extends ConsentRecordState {
  subject: ConsentSubject;
  decidedAt: string;
  revokedAt: string | null;
  /** 入力項目を見せた版 (NULL = まだ見せていない) と、その時に見せた列 */
  fieldsVersion: number | null;
  fieldsSeen: string[];
}

/** 同意と同じトランザクションで行う入力項目の保存 (signup-fields/store.ts)。 */
export type ConsentTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface FieldsDecision {
  version: number;
  seen: string[];
  /** project_data_<slug> への書き込み。失敗すれば同意の保存も戻る */
  write?: (tx: ConsentTransaction) => Promise<void>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toStored(row: typeof schema.userServiceConsents.$inferSelect): StoredConsent {
  return {
    subject: { kind: row.subjectKind as ConsentSubjectKind, key: row.subjectKey },
    declarationVersion: row.declarationVersion,
    granted: stringArray(row.granted),
    denied: stringArray(row.denied),
    revoked: row.revokedAt !== null,
    decidedAt: row.decidedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    fieldsVersion: row.fieldsVersion ?? null,
    fieldsSeen: stringArray(row.fieldsSeen),
  };
}

function subjectWhere(userId: string, subject: ConsentSubject) {
  return and(
    eq(schema.userServiceConsents.userId, userId),
    eq(schema.userServiceConsents.subjectKind, subject.kind),
    eq(schema.userServiceConsents.subjectKey, subject.key),
  );
}

export async function getConsentRecord(userId: string, subject: ConsentSubject): Promise<StoredConsent | null> {
  const rows = await db.select().from(schema.userServiceConsents).where(subjectWhere(userId, subject)).limit(1);
  return rows[0] ? toStored(rows[0]) : null;
}

export async function listConsentRecords(userId: string): Promise<StoredConsent[]> {
  const rows = await db.select().from(schema.userServiceConsents)
    .where(eq(schema.userServiceConsents.userId, userId));
  return rows.map(toStored);
}

interface Decision {
  version: number;
  granted: string[];
  denied: string[];
}

function auditRow(userId: string, subject: ConsentSubject, action: ConsentAction, decision: Decision) {
  return {
    id: crypto.randomUUID(),
    userId,
    subjectKind: subject.kind,
    subjectKey: subject.key,
    declarationVersion: decision.version,
    action,
    granted: decision.granted,
    denied: decision.denied,
  };
}

/**
 * 許可 (初回 grant / 変更 update) を保存する。取り消し済みの行は復活させる。
 * `fields` を渡すと、入力値の書き込みと見せた版の記録を同じトランザクションで行う (設計書 §4.1)。
 */
export async function saveConsent(
  userId: string,
  subject: ConsentSubject,
  action: "grant" | "update",
  decision: Decision,
  fields?: FieldsDecision,
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    const fieldsSet = fields ? { fieldsVersion: fields.version, fieldsSeen: fields.seen } : {};
    await tx.insert(schema.userServiceConsents).values({
      userId, subjectKind: subject.kind, subjectKey: subject.key,
      declarationVersion: decision.version, granted: decision.granted, denied: decision.denied,
      decidedAt: now, revokedAt: null, ...fieldsSet,
    }).onConflictDoUpdate({
      target: [schema.userServiceConsents.userId, schema.userServiceConsents.subjectKind, schema.userServiceConsents.subjectKey],
      set: { declarationVersion: decision.version, granted: decision.granted, denied: decision.denied, decidedAt: now, revokedAt: null, ...fieldsSet },
    });
    await tx.insert(schema.consentDecisions).values(auditRow(userId, subject, action, decision));
    if (fields?.write) await fields.write(tx);
  });
}

/** 必須を拒否してログインを中止した記録。同意の行は作らない (次回また聞く)。 */
export async function recordDenial(userId: string, subject: ConsentSubject, decision: Decision): Promise<void> {
  await db.insert(schema.consentDecisions).values(auditRow(userId, subject, "deny", decision));
}

/** 同意の取り消し (= そのサービスの利用停止)。次のログインで再び同意画面が出る。 */
export async function revokeConsent(userId: string, subject: ConsentSubject, version: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.update(schema.userServiceConsents).set({ revokedAt: new Date() })
      .where(subjectWhere(userId, subject)).returning({ granted: schema.userServiceConsents.granted });
    if (updated.length === 0) return false;
    await tx.insert(schema.consentDecisions).values(auditRow(userId, subject, "revoke", {
      version, granted: [], denied: stringArray(updated[0].granted),
    }));
    return true;
  });
}
