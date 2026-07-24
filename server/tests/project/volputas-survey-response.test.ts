import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VOLPUTAS_SURVEY_ANSWERS,
  MAX_VOLPUTAS_SURVEY_IDS,
  MAX_VOLPUTAS_TEXT_ANSWER_LENGTH,
  type PersistedVolputasSurveyResponseInput,
  type VolputasSurveyResponse,
} from "../../src/project/volputas-survey-response-contract.js";
import type {
  VolputasSurveyResponseRepository,
} from "../../src/project/volputas-survey-response-repository.js";
import {
  createVolputasSurveyResponseService,
} from "../../src/project/volputas-survey-response.js";

const USER_ID = "6f1d0b9b-179a-4fc7-a643-d3228fe350b2";
const SURVEY_ID = "53ce1ee5-0b08-4f71-9b7b-c9c424f09024";
const OTHER_SURVEY_ID = "f9918b28-889d-4c50-9cbf-a3e90d885ca9";
const SUBMITTED_AT = new Date("2026-07-24T03:04:05.000Z");

function createHarness() {
  const storedResponse: VolputasSurveyResponse = {
    surveyId: SURVEY_ID,
    answers: [{ questionId: "rating", intValue: 4 }],
    submittedAt: SUBMITTED_AT.toISOString(),
  };
  const repository: VolputasSurveyResponseRepository = {
    listAnsweredSurveyIds: vi.fn(async () => [SURVEY_ID]),
    findResponse: vi.fn(async () => storedResponse),
    replaceResponse: vi.fn(async (input: PersistedVolputasSurveyResponseInput) => ({
      surveyId: input.surveyId,
      answers: input.answers,
      submittedAt: input.submittedAt.toISOString(),
    })),
  };
  return {
    repository,
    service: createVolputasSurveyResponseService({
      repository,
      now: () => new Date(SUBMITTED_AT.getTime()),
    }),
  };
}

describe("Volputas survey response service", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("lists statuses, loads a response, and saves normalized answers", async () => {
    await expect(harness.service.listResponseStatuses({
      userId: USER_ID,
      surveyIds: [SURVEY_ID, OTHER_SURVEY_ID],
    })).resolves.toEqual({ answeredSurveyIds: [SURVEY_ID] });
    expect(harness.repository.listAnsweredSurveyIds).toHaveBeenCalledWith(
      USER_ID,
      [SURVEY_ID, OTHER_SURVEY_ID],
    );

    await expect(harness.service.getResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
    })).resolves.toMatchObject({
      surveyId: SURVEY_ID,
      submittedAt: SUBMITTED_AT.toISOString(),
    });

    const answers = [
      { questionId: "rating", intValue: 5 },
      { questionId: "comment", textValue: "safe 😀 fixture" },
    ];
    await expect(harness.service.saveResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers,
    })).resolves.toEqual({
      surveyId: SURVEY_ID,
      answers,
      submittedAt: SUBMITTED_AT.toISOString(),
    });
    expect(harness.repository.replaceResponse).toHaveBeenCalledWith({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers,
      submittedAt: SUBMITTED_AT,
    });
  });

  it("accepts the declared collection and answer boundaries", async () => {
    const surveyIds = Array.from(
      { length: MAX_VOLPUTAS_SURVEY_IDS },
      (_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    await expect(harness.service.listResponseStatuses({
      userId: USER_ID,
      surveyIds,
    })).resolves.toEqual({ answeredSurveyIds: [SURVEY_ID] });

    const answers = Array.from(
      { length: MAX_VOLPUTAS_SURVEY_ANSWERS },
      (_, index) => ({ questionId: `q${index}`, intValue: index }),
    );
    answers[0] = {
      questionId: "comment",
      intValue: 0,
    };
    await expect(harness.service.saveResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers: [
        ...answers.slice(0, -1),
        {
          questionId: "long_comment",
          textValue: "x".repeat(MAX_VOLPUTAS_TEXT_ANSWER_LENGTH),
        },
      ],
    })).resolves.toMatchObject({ surveyId: SURVEY_ID });
  });

  it("rejects invalid UUIDs and collection sizes before repository access", async () => {
    await expect(harness.service.getResponse({
      userId: "not-a-uuid",
      surveyId: SURVEY_ID,
    })).rejects.toThrow();
    await expect(harness.service.listResponseStatuses({
      userId: USER_ID,
      surveyIds: Array.from(
        { length: MAX_VOLPUTAS_SURVEY_IDS + 1 },
        () => SURVEY_ID,
      ),
    })).rejects.toThrow();
    await expect(harness.service.saveResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers: Array.from(
        { length: MAX_VOLPUTAS_SURVEY_ANSWERS + 1 },
        (_, index) => ({ questionId: `q${index}`, intValue: index }),
      ),
    })).rejects.toThrow();

    expect(harness.repository.findResponse).not.toHaveBeenCalled();
    expect(harness.repository.listAnsweredSurveyIds).not.toHaveBeenCalled();
    expect(harness.repository.replaceResponse).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "both answer representations",
      answer: { questionId: "rating", textValue: "5", intValue: 5 },
    },
    {
      name: "neither answer representation",
      answer: { questionId: "rating" },
    },
    {
      name: "unsafe question ID",
      answer: { questionId: "Rating.Value", intValue: 5 },
    },
    {
      name: "text beyond 4,000 characters",
      answer: {
        questionId: "comment",
        textValue: "x".repeat(MAX_VOLPUTAS_TEXT_ANSWER_LENGTH + 1),
      },
    },
    {
      name: "PostgreSQL-incompatible NUL text",
      answer: { questionId: "comment", textValue: "before\u0000after" },
    },
    {
      name: "unpaired UTF-16 surrogate",
      answer: { questionId: "comment", textValue: "trailing\uD800" },
    },
    {
      name: "integer beyond PostgreSQL INTEGER",
      answer: { questionId: "rating", intValue: 2_147_483_648 },
    },
  ])("rejects $name", async ({ answer }) => {
    await expect(harness.service.saveResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers: [answer],
    })).rejects.toThrow();
    expect(harness.repository.replaceResponse).not.toHaveBeenCalled();
  });

  it("rejects duplicate question IDs before repository access", async () => {
    await expect(harness.service.saveResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers: [
        { questionId: "comment", textValue: "first" },
        { questionId: "comment", textValue: "second" },
      ],
    })).rejects.toThrow(/duplicate questionId/);
    expect(harness.repository.replaceResponse).not.toHaveBeenCalled();
  });

  it("fails closed when the injected clock returns an invalid date", async () => {
    const service = createVolputasSurveyResponseService({
      repository: harness.repository,
      now: () => new Date(Number.NaN),
    });
    await expect(service.saveResponse({
      userId: USER_ID,
      surveyId: SURVEY_ID,
      answers: [],
    })).rejects.toThrow(/invalid date/);
    expect(harness.repository.replaceResponse).not.toHaveBeenCalled();
  });
});
