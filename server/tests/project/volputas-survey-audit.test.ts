import { describe, expect, it, vi } from "vitest";

import {
  classifyVolputasSurveyAuditError,
  extractVolputasSurveyAuditIdentifiers,
  isVolputasSurveyAuditAction,
  VolputasSurveyAuthorizationError,
  VOLPUTAS_SURVEY_AUDIT_ERROR_CODES,
} from "../../src/project/volputas-survey-audit-contract.js";
import {
  volputasSurveyAuditCutoff,
  VOLPUTAS_SURVEY_AUDIT_RETENTION_DAYS,
} from "../../src/project/volputas-survey-audit-repository.js";
import { createVolputasSurveyAuditRecorder } from "../../src/project/volputas-survey-audit.js";

const USER_ID = "6f1d0b9b-179a-4fc7-a643-d3228fe350b2";
const SURVEY_ID = "53ce1ee5-0b08-4f71-9b7b-c9c424f09024";

describe("volputas survey audit identifiers", () => {
  it("keeps only UUID-shaped user and survey ids", () => {
    expect(extractVolputasSurveyAuditIdentifiers({
      userId: USER_ID,
      surveyId: SURVEY_ID,
    })).toEqual({ userId: USER_ID, surveyId: SURVEY_ID });
  });

  it("drops non-UUID values instead of recording them", () => {
    expect(extractVolputasSurveyAuditIdentifiers({
      userId: "not-a-uuid",
      surveyId: "'; DROP TABLE users; --",
    })).toEqual({ userId: null, surveyId: null });
  });

  it("ignores every other payload key, including answers", () => {
    const identifiers = extractVolputasSurveyAuditIdentifiers({
      userId: USER_ID,
      answers: [{ questionId: "free_text", textValue: "sensitive answer" }],
      accessToken: "secret-token",
    });

    expect(identifiers).toEqual({ userId: USER_ID, surveyId: null });
    expect(JSON.stringify(identifiers)).not.toContain("sensitive answer");
    expect(JSON.stringify(identifiers)).not.toContain("secret-token");
  });

  it.each([null, undefined, "string", 42, [USER_ID]])(
    "returns nulls for non-object payload %s",
    (payload) => {
      expect(extractVolputasSurveyAuditIdentifiers(payload))
        .toEqual({ userId: null, surveyId: null });
    },
  );
});

describe("volputas survey audit error classification", () => {
  it("maps the authorization sentinel to project_not_authorized", () => {
    expect(classifyVolputasSurveyAuditError(new VolputasSurveyAuthorizationError()))
      .toBe("project_not_authorized");
  });

  it("maps zod-shaped validation errors to invalid_payload", () => {
    const byName = Object.assign(new Error("bad"), { name: "ZodError" });
    const byShape = Object.assign(new Error("bad"), { issues: [{ message: "x" }] });

    expect(classifyVolputasSurveyAuditError(byName)).toBe("invalid_payload");
    expect(classifyVolputasSurveyAuditError(byShape)).toBe("invalid_payload");
  });

  it("maps SQLSTATE-carrying errors to storage_failure", () => {
    expect(classifyVolputasSurveyAuditError(
      Object.assign(new Error("dup"), { code: "23505" }),
    )).toBe("storage_failure");
  });

  it("falls back to internal_error for anything else", () => {
    expect(classifyVolputasSurveyAuditError(new Error("boom"))).toBe("internal_error");
    expect(classifyVolputasSurveyAuditError("boom")).toBe("internal_error");
    expect(classifyVolputasSurveyAuditError(null)).toBe("internal_error");
    // ENOENT 等の非 SQLSTATE code は storage_failure にしない。
    expect(classifyVolputasSurveyAuditError(
      Object.assign(new Error("fs"), { code: "ENOENT" }),
    )).toBe("internal_error");
  });

  it("only ever produces codes the database CHECK constraint accepts", () => {
    const produced = [
      classifyVolputasSurveyAuditError(new VolputasSurveyAuthorizationError()),
      classifyVolputasSurveyAuditError(Object.assign(new Error(""), { name: "ZodError" })),
      classifyVolputasSurveyAuditError(Object.assign(new Error(""), { code: "23505" })),
      classifyVolputasSurveyAuditError(new Error("")),
    ];

    for (const code of produced) {
      expect(VOLPUTAS_SURVEY_AUDIT_ERROR_CODES).toContain(code);
    }
  });

  it("never reads the exception message", () => {
    const leaky = new Error("answer=very sensitive confession");
    expect(classifyVolputasSurveyAuditError(leaky)).toBe("internal_error");
  });
});

describe("volputas survey audit action vocabulary", () => {
  it.each(["list_response_statuses", "get_response", "save_response"])(
    "accepts %s",
    (action) => expect(isVolputasSurveyAuditAction(action)).toBe(true),
  );

  it.each(["delete_response", "", "GET_RESPONSE", null, 7])(
    "rejects %s",
    (action) => expect(isVolputasSurveyAuditAction(action)).toBe(false),
  );
});

describe("volputas survey audit recorder (fail-safe)", () => {
  it("writes the entry through the repository on the happy path", async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const recorder = createVolputasSurveyAuditRecorder({
      repository: { insert, purgeExpired: vi.fn() },
    });

    await recorder.record({
      projectKey: "volputas",
      userId: USER_ID,
      surveyId: SURVEY_ID,
      action: "get_response",
      status: "ok",
      errorCode: null,
    });

    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("swallows repository failures so the caller is unaffected", async () => {
    const onFailure = vi.fn();
    const recorder = createVolputasSurveyAuditRecorder({
      repository: {
        insert: vi.fn().mockRejectedValue(new Error("sink down")),
        purgeExpired: vi.fn(),
      },
      onFailure,
    });

    await expect(recorder.record({
      projectKey: "volputas",
      userId: USER_ID,
      surveyId: SURVEY_ID,
      action: "save_response",
      status: "ok",
      errorCode: null,
    })).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("stays silent-safe even when the failure notifier itself throws", async () => {
    const recorder = createVolputasSurveyAuditRecorder({
      repository: {
        insert: vi.fn().mockRejectedValue(new Error("sink down")),
        purgeExpired: vi.fn(),
      },
      onFailure: () => { throw new Error("logger down"); },
    });

    await expect(recorder.record({
      projectKey: "volputas",
      userId: null,
      surveyId: null,
      action: "get_response",
      status: "denied",
      errorCode: "project_not_authorized",
    })).resolves.toBeUndefined();
  });
});

describe("volputas survey audit retention", () => {
  it("keeps the documented 365 day window", () => {
    expect(VOLPUTAS_SURVEY_AUDIT_RETENTION_DAYS).toBe(365);
  });

  it("computes the cutoff relative to the supplied clock", () => {
    const now = new Date("2026-07-25T00:00:00.000Z");
    expect(volputasSurveyAuditCutoff(now).toISOString())
      .toBe("2025-07-25T00:00:00.000Z");
  });
});
