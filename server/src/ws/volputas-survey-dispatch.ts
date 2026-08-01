/**
 * Volputas survey コマンドの監査付きディスパッチ。
 *
 * project WS は user WS の dispatch を通らないため operation_logs には残らない。
 * Cernere が預かる中で最も機微な store (本人のアンケート回答) の参照・上書きを
 * 無記録にしないよう、この経路だけの監査シンクを噛ませる。
 *
 * 記録するのは project / user / survey / action / status / 固定 error 区分のみ。
 * 成功・失敗・認可拒否の 3 パターンすべてを記録し、監査ログの書き込み失敗は
 * fail-safe (本処理を止めない) として扱う。
 */

import {
  classifyVolputasSurveyAuditError,
  extractVolputasSurveyAuditIdentifiers,
  isVolputasSurveyAuditAction,
  VolputasSurveyAuthorizationError,
  type VolputasSurveyAuditAction,
  type VolputasSurveyAuditEntry,
} from "../project/volputas-survey-audit-contract.js";
import {
  volputasSurveyAuditRecorder,
  type VolputasSurveyAuditRecorder,
} from "../project/volputas-survey-audit.js";

export const VOLPUTAS_PROJECT_KEY = "volputas";

/** 実処理側 (project/volputas-survey-response.js) の最小インタフェース。 */
export interface VolputasSurveyCommandHandlers {
  listResponseStatuses(payload: unknown): Promise<unknown>;
  getResponse(payload: unknown): Promise<unknown>;
  saveResponse(payload: unknown): Promise<unknown>;
}

export interface VolputasSurveyDispatchDeps {
  recorder?: VolputasSurveyAuditRecorder;
  loadHandlers?: () => Promise<VolputasSurveyCommandHandlers>;
}

function loadDefaultHandlers(): Promise<VolputasSurveyCommandHandlers> {
  return import("../project/volputas-survey-response.js");
}

export async function dispatchVolputasSurveyCommand(
  projectKey: string,
  action: string,
  payload: Record<string, unknown>,
  {
    recorder = volputasSurveyAuditRecorder,
    loadHandlers = loadDefaultHandlers,
  }: VolputasSurveyDispatchDeps = {},
): Promise<unknown> {
  if (!isVolputasSurveyAuditAction(action)) {
    // 未知の action は監査語彙 (固定集合) に載せられないので記録せず拒否する。
    throw new Error(`Unknown command: volputas_survey.${action} (project: ${projectKey})`);
  }

  const { userId, surveyId } = extractVolputasSurveyAuditIdentifiers(payload);
  const base = { projectKey, userId, surveyId, action };

  // 認可拒否は実処理・DB アクセスより前に判定し、拒否そのものを監査に残す。
  if (projectKey !== VOLPUTAS_PROJECT_KEY) {
    const denied = new VolputasSurveyAuthorizationError();
    await recordSafely(recorder, {
      ...base,
      status: "denied",
      errorCode: "project_not_authorized",
    });
    throw denied;
  }

  try {
    const handlers = await loadHandlers();
    const result = await runHandler(handlers, action, payload);
    await recordSafely(recorder, { ...base, status: "ok", errorCode: null });
    return result;
  } catch (error) {
    await recordSafely(recorder, {
      ...base,
      status: "error",
      errorCode: classifyVolputasSurveyAuditError(error),
    });
    // 監査の失敗で本来の例外をすり替えない。
    throw error;
  }
}

/**
 * 監査書き込みの fail-safe 境界。
 *
 * recorder は「throw しない」契約だが、契約に依存すると差し替え実装や将来の
 * 退行がそのまま本処理の停止・例外すり替えに化ける。監査は本処理より優先度が
 * 低いという判断をこの境界で強制する。
 */
async function recordSafely(
  recorder: VolputasSurveyAuditRecorder,
  entry: VolputasSurveyAuditEntry,
): Promise<void> {
  try {
    await recorder.record(entry);
  } catch {
    // recorder 自身が握り潰しに失敗した場合の最終防壁。
  }
}

function runHandler(
  handlers: VolputasSurveyCommandHandlers,
  action: VolputasSurveyAuditAction,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "list_response_statuses":
      return handlers.listResponseStatuses(payload);
    case "get_response":
      return handlers.getResponse(payload);
    case "save_response":
      return handlers.saveResponse(payload);
  }
}
