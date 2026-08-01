/**
 * Volputas survey アクセス監査ログの語彙 (純粋ロジック、DB 非依存)。
 *
 * 監査対象は「誰がどの survey に何をして、どう終わったか」のみ。
 * 回答本文 / payload / token / credential は決して載せない。error は自由文では
 * なく閉じた区分値にして、例外メッセージ経由の回答漏洩を構造的に不可能にする。
 */

/** 監査対象コマンド。project-dispatch の volputas_survey.* と 1:1。 */
export const VOLPUTAS_SURVEY_AUDIT_ACTIONS = [
  "list_response_statuses",
  "get_response",
  "save_response",
] as const;

export type VolputasSurveyAuditAction =
  (typeof VOLPUTAS_SURVEY_AUDIT_ACTIONS)[number];

/**
 * ok    ... コマンド成功
 * denied... 認可拒否 (Volputas 以外の project が触ろうとした)
 * error ... 実行失敗 (入力不正 / ストレージ障害 / その他)
 */
export const VOLPUTAS_SURVEY_AUDIT_STATUSES = ["ok", "error", "denied"] as const;

export type VolputasSurveyAuditStatus =
  (typeof VOLPUTAS_SURVEY_AUDIT_STATUSES)[number];

/** 固定化された error 区分。DB 側 CHECK 制約と同一集合。 */
export const VOLPUTAS_SURVEY_AUDIT_ERROR_CODES = [
  "project_not_authorized",
  "invalid_payload",
  "storage_failure",
  "internal_error",
] as const;

export type VolputasSurveyAuditErrorCode =
  (typeof VOLPUTAS_SURVEY_AUDIT_ERROR_CODES)[number];

export interface VolputasSurveyAuditEntry {
  projectKey: string;
  userId: string | null;
  surveyId: string | null;
  action: VolputasSurveyAuditAction;
  status: VolputasSurveyAuditStatus;
  errorCode: VolputasSurveyAuditErrorCode | null;
}

/** 認可拒否を他の失敗と区別するための番兵例外。 */
export class VolputasSurveyAuthorizationError extends Error {
  constructor(message = "Volputas survey commands require the Volputas project") {
    super(message);
    this.name = "VolputasSurveyAuthorizationError";
  }
}

export function isVolputasSurveyAuditAction(
  value: unknown,
): value is VolputasSurveyAuditAction {
  return typeof value === "string"
    && (VOLPUTAS_SURVEY_AUDIT_ACTIONS as readonly string[]).includes(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL の SQLSTATE は 5 桁英数字。ドライバ差異を吸収するため形だけ見る。 */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * payload から監査に載せてよい識別子だけを抜き出す。
 *
 * 読むキーは userId / surveyId のみで、UUID 形でなければ null に落とす。
 * これにより「未検証 payload をそのまま監査に流し込む」経路が存在しなくなり、
 * 回答本文や token が識別子カラムへ紛れ込む余地を無くす。
 */
export function extractVolputasSurveyAuditIdentifiers(payload: unknown): {
  userId: string | null;
  surveyId: string | null;
} {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { userId: null, surveyId: null };
  }
  const record = payload as Record<string, unknown>;
  return {
    userId: asUuidOrNull(record.userId),
    surveyId: asUuidOrNull(record.surveyId),
  };
}

function asUuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * 例外を固定 error 区分へ写像する。メッセージ本文は一切参照しない
 * (メッセージに回答値が混ざっていても監査ログには出ない)。
 */
export function classifyVolputasSurveyAuditError(
  error: unknown,
): VolputasSurveyAuditErrorCode {
  if (error instanceof VolputasSurveyAuthorizationError) {
    return "project_not_authorized";
  }
  if (isZodError(error)) return "invalid_payload";
  if (isDatabaseError(error)) return "storage_failure";
  return "internal_error";
}

function isZodError(error: unknown): boolean {
  // zod のバージョン差 / 多重インスタンスに耐えるため名前と形で判定する。
  if (!(error instanceof Error)) return false;
  if (error.name === "ZodError") return true;
  return Array.isArray((error as { issues?: unknown }).issues);
}

function isDatabaseError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SQLSTATE_PATTERN.test(code);
}
