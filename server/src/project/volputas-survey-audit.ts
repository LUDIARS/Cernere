/**
 * Volputas survey アクセス監査の記録器 (fail-safe 方針の所在)。
 *
 * 監査ログ自体の書き込み失敗で本処理 (回答の参照・保存) を止めない。
 * 監査要件上、失敗を無音にはせず stderr へ区分値だけ出す — ここでも例外
 * メッセージに含まれ得る回答値は出力しない。
 */

import {
  volputasSurveyAuditRepository,
  type VolputasSurveyAuditRepository,
} from "./volputas-survey-audit-repository.js";
import type { VolputasSurveyAuditEntry } from "./volputas-survey-audit-contract.js";

export interface VolputasSurveyAuditRecorder {
  /** 決して throw しない。 */
  record(entry: VolputasSurveyAuditEntry): Promise<void>;
}

interface RecorderOptions {
  repository?: VolputasSurveyAuditRepository;
  onFailure?: (entry: VolputasSurveyAuditEntry) => void;
}

function defaultOnFailure(entry: VolputasSurveyAuditEntry): void {
  // 監査シンクが落ちたこと自体は運用者に見せる必要がある。
  // 出すのは固定区分値のみ (回答本文・例外メッセージは出さない)。
  console.error(
    "[volputas_survey_access_logs] insert failed (audit trail at risk):",
    `project=${entry.projectKey}`,
    `action=${entry.action}`,
    `status=${entry.status}`,
    `error_code=${entry.errorCode ?? "none"}`,
  );
}

export function createVolputasSurveyAuditRecorder({
  repository = volputasSurveyAuditRepository,
  onFailure = defaultOnFailure,
}: RecorderOptions = {}): VolputasSurveyAuditRecorder {
  return {
    async record(entry) {
      try {
        await repository.insert(entry);
      } catch {
        try {
          onFailure(entry);
        } catch {
          // 通知経路の失敗まで本処理へ伝播させない。
        }
      }
    },
  };
}

export const volputasSurveyAuditRecorder = createVolputasSurveyAuditRecorder();
