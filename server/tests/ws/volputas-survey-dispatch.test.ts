import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  VolputasSurveyAuthorizationError,
  type VolputasSurveyAuditEntry,
} from "../../src/project/volputas-survey-audit-contract.js";
import {
  dispatchVolputasSurveyCommand,
  type VolputasSurveyCommandHandlers,
} from "../../src/ws/volputas-survey-dispatch.js";
import { createVolputasSurveyAuditRecorder } from "../../src/project/volputas-survey-audit.js";

const USER_ID = "6f1d0b9b-179a-4fc7-a643-d3228fe350b2";
const SURVEY_ID = "53ce1ee5-0b08-4f71-9b7b-c9c424f09024";

const listResponseStatuses = vi.fn();
const getResponse = vi.fn();
const saveResponse = vi.fn();

const handlers: VolputasSurveyCommandHandlers = {
  listResponseStatuses: (payload) => listResponseStatuses(payload),
  getResponse: (payload) => getResponse(payload),
  saveResponse: (payload) => saveResponse(payload),
};

/** 記録された監査エントリを集める最小 recorder。 */
function collectingRecorder(entries: VolputasSurveyAuditEntry[]) {
  return {
    record: async (entry: VolputasSurveyAuditEntry) => {
      entries.push(entry);
    },
  };
}

function dispatch(
  projectKey: string,
  action: string,
  payload: Record<string, unknown>,
  entries: VolputasSurveyAuditEntry[],
) {
  return dispatchVolputasSurveyCommand(projectKey, action, payload, {
    recorder: collectingRecorder(entries),
    loadHandlers: async () => handlers,
  });
}

describe("dispatchVolputasSurveyCommand — access audit", () => {
  let entries: VolputasSurveyAuditEntry[];

  beforeEach(() => {
    entries = [];
    listResponseStatuses.mockReset().mockResolvedValue({ answeredSurveyIds: [] });
    getResponse.mockReset().mockResolvedValue(null);
    saveResponse.mockReset().mockResolvedValue({ surveyId: SURVEY_ID });
  });

  // ── 1. 成功 ────────────────────────────────────────────────
  it("records a metadata-only ok entry for a successful read", async () => {
    const result = await dispatch(
      "volputas",
      "get_response",
      { userId: USER_ID, surveyId: SURVEY_ID },
      entries,
    );

    expect(result).toBeNull();
    expect(getResponse).toHaveBeenCalledWith({ userId: USER_ID, surveyId: SURVEY_ID });
    expect(entries).toEqual([{
      projectKey: "volputas",
      userId: USER_ID,
      surveyId: SURVEY_ID,
      action: "get_response",
      status: "ok",
      errorCode: null,
    }]);
  });

  it("never records answer values when a response is overwritten", async () => {
    await dispatch(
      "volputas",
      "save_response",
      {
        userId: USER_ID,
        surveyId: SURVEY_ID,
        answers: [
          { questionId: "free_text", textValue: "secret personal confession" },
          { questionId: "rating", intValue: 4 },
        ],
      },
      entries,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      projectKey: "volputas",
      userId: USER_ID,
      surveyId: SURVEY_ID,
      action: "save_response",
      status: "ok",
      errorCode: null,
    });
    // 監査エントリ全体を直列化しても回答本文は現れない。
    expect(JSON.stringify(entries)).not.toContain("secret personal confession");
    expect(JSON.stringify(entries)).not.toContain("free_text");
  });

  it("leaves survey_id null for the multi-survey status listing", async () => {
    await dispatch(
      "volputas",
      "list_response_statuses",
      { userId: USER_ID, surveyIds: [SURVEY_ID] },
      entries,
    );

    expect(entries[0]).toMatchObject({
      action: "list_response_statuses",
      status: "ok",
      surveyId: null,
    });
  });

  // ── 2. 失敗 ────────────────────────────────────────────────
  it("records a fixed error class when the payload is rejected", async () => {
    const zodLike = Object.assign(new Error("invalid"), {
      name: "ZodError",
      issues: [{ path: ["answers", 0, "textValue"], message: "too long" }],
    });
    saveResponse.mockRejectedValue(zodLike);

    await expect(dispatch(
      "volputas",
      "save_response",
      { userId: USER_ID, surveyId: SURVEY_ID, answers: [] },
      entries,
    )).rejects.toBe(zodLike);

    expect(entries).toEqual([{
      projectKey: "volputas",
      userId: USER_ID,
      surveyId: SURVEY_ID,
      action: "save_response",
      status: "error",
      errorCode: "invalid_payload",
    }]);
  });

  it("classifies a database failure as storage_failure without its message", async () => {
    const dbError = Object.assign(new Error("duplicate key value: answer=confession"), {
      code: "23505",
    });
    saveResponse.mockRejectedValue(dbError);

    await expect(dispatch(
      "volputas",
      "save_response",
      { userId: USER_ID, surveyId: SURVEY_ID, answers: [] },
      entries,
    )).rejects.toBe(dbError);

    expect(entries[0]).toMatchObject({ status: "error", errorCode: "storage_failure" });
    expect(JSON.stringify(entries)).not.toContain("confession");
  });

  it("falls back to internal_error for unclassified failures", async () => {
    getResponse.mockRejectedValue(new Error("boom"));

    await expect(dispatch(
      "volputas",
      "get_response",
      { userId: USER_ID, surveyId: SURVEY_ID },
      entries,
    )).rejects.toThrow("boom");

    expect(entries[0]).toMatchObject({ status: "error", errorCode: "internal_error" });
  });

  // ── 3. 認可拒否 ────────────────────────────────────────────
  it.each([
    "list_response_statuses",
    "get_response",
    "save_response",
  ])("records a denied entry for %s from another project", async (action) => {
    await expect(dispatch(
      "EducationLab",
      action,
      { userId: USER_ID, surveyId: SURVEY_ID, surveyIds: [SURVEY_ID], answers: [] },
      entries,
    )).rejects.toThrow(/require the Volputas project/);

    expect(entries).toEqual([{
      projectKey: "EducationLab",
      userId: USER_ID,
      surveyId: SURVEY_ID,
      action,
      status: "denied",
      errorCode: "project_not_authorized",
    }]);
    // 拒否は実処理より前に確定する。
    expect(listResponseStatuses).not.toHaveBeenCalled();
    expect(getResponse).not.toHaveBeenCalled();
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("audits the denial before any handler module is even loaded", async () => {
    const loadHandlers = vi.fn(async () => handlers);

    await expect(dispatchVolputasSurveyCommand(
      "EducationLab",
      "get_response",
      { userId: USER_ID, surveyId: SURVEY_ID },
      { recorder: collectingRecorder(entries), loadHandlers },
    )).rejects.toBeInstanceOf(VolputasSurveyAuthorizationError);

    expect(loadHandlers).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({ status: "denied" });
  });

  // ── 4. 監査ログ書き込み失敗 (fail-safe) ────────────────────
  it("does not fail the command when the audit write fails", async () => {
    const failing = {
      record: vi.fn().mockRejectedValue(new Error("audit sink down")),
    };
    getResponse.mockResolvedValue({ surveyId: SURVEY_ID, answers: [], submittedAt: "x" });

    const result = await dispatchVolputasSurveyCommand(
      "volputas",
      "get_response",
      { userId: USER_ID, surveyId: SURVEY_ID },
      { recorder: failing, loadHandlers: async () => handlers },
    );

    // 監査シンクが落ちても本処理の結果はそのまま返る。
    expect(result).toEqual({ surveyId: SURVEY_ID, answers: [], submittedAt: "x" });
    expect(failing.record).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the original error when the audit write also fails", async () => {
    const failing = {
      record: vi.fn().mockRejectedValue(new Error("audit sink down")),
    };
    saveResponse.mockRejectedValue(new Error("original failure"));

    await expect(dispatchVolputasSurveyCommand(
      "volputas",
      "save_response",
      { userId: USER_ID, surveyId: SURVEY_ID, answers: [] },
      { recorder: failing, loadHandlers: async () => handlers },
    )).rejects.toThrow("original failure");
  });

  it("keeps the recorder itself from throwing when the repository fails", async () => {
    const onFailure = vi.fn();
    const recorder = createVolputasSurveyAuditRecorder({
      repository: {
        insert: vi.fn().mockRejectedValue(new Error("insert exploded")),
        purgeExpired: vi.fn(),
      },
      onFailure,
    });

    const result = await dispatchVolputasSurveyCommand(
      "volputas",
      "get_response",
      { userId: USER_ID, surveyId: SURVEY_ID },
      { recorder, loadHandlers: async () => handlers },
    );

    expect(result).toBeNull();
    // 無音にはせず、固定区分値だけを運用者へ出す。
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: "ok",
      errorCode: null,
      projectKey: "volputas",
    }));
  });

  // ── 未知 action ────────────────────────────────────────────
  it("rejects an action outside the closed audit vocabulary", async () => {
    await expect(dispatch(
      "volputas",
      "delete_response",
      { userId: USER_ID },
      entries,
    )).rejects.toThrow(/Unknown command/);

    expect(entries).toEqual([]);
  });
});
