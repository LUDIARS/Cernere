/**
 * Volputas survey アクセス監査ログの永続化 (SQL 層のみ)。
 *
 * fail-safe 方針 (書き込み失敗を本処理へ伝播させない) は上位の recorder が持つ。
 * ここは素直に投げる — 呼び出し側が握り潰しの責任範囲を明示できるようにする。
 */

import { lt } from "drizzle-orm";
import { db, type Database } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type { VolputasSurveyAuditEntry } from "./volputas-survey-audit-contract.js";

/**
 * 監査ログの保持期間 (spec/data/retention.md)。
 * 個人データそのものではないメタデータだが user_id を含むため無期限保持はしない。
 */
export const VOLPUTAS_SURVEY_AUDIT_RETENTION_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface VolputasSurveyAuditRepository {
  insert(entry: VolputasSurveyAuditEntry): Promise<void>;
  /** 保持期間を過ぎた行を削除し、削除件数を返す。 */
  purgeExpired(now?: Date): Promise<number>;
}

export function volputasSurveyAuditCutoff(
  now: Date,
  retentionDays: number = VOLPUTAS_SURVEY_AUDIT_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

export function createVolputasSurveyAuditRepository(
  database: Database = db,
): VolputasSurveyAuditRepository {
  return {
    async insert(entry) {
      await database.insert(schema.volputasSurveyAccessLogs).values({
        projectKey: entry.projectKey,
        userId: entry.userId,
        surveyId: entry.surveyId,
        action: entry.action,
        status: entry.status,
        errorCode: entry.errorCode,
      });
    },

    async purgeExpired(now = new Date()) {
      const cutoff = volputasSurveyAuditCutoff(now);
      const deleted = await database
        .delete(schema.volputasSurveyAccessLogs)
        .where(lt(schema.volputasSurveyAccessLogs.createdAt, cutoff))
        .returning({ id: schema.volputasSurveyAccessLogs.id });
      return deleted.length;
    },
  };
}

export const volputasSurveyAuditRepository =
  createVolputasSurveyAuditRepository();
