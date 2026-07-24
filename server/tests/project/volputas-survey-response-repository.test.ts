import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/db/connection.js";
import * as schema from "../../src/db/schema.js";
import {
  createVolputasSurveyResponseRepository,
} from "../../src/project/volputas-survey-response-repository.js";
import type {
  PersistedVolputasSurveyResponseInput,
  VolputasSurveyAnswer,
} from "../../src/project/volputas-survey-response-contract.js";

const USER_ID = "6f1d0b9b-179a-4fc7-a643-d3228fe350b2";
const SURVEY_ID = "53ce1ee5-0b08-4f71-9b7b-c9c424f09024";
const RESPONSE_ID = "fc782587-1261-4368-9bce-51a569a5962d";
const PREVIOUS_SUBMITTED_AT = new Date("2026-07-23T00:00:00.000Z");
const NEXT_SUBMITTED_AT = new Date("2026-07-24T00:00:00.000Z");

interface FakeResponseRow {
  id: string;
  surveyId: string;
  userId: string;
  submittedAt: Date;
  updatedAt: Date;
}

interface FakeState {
  response: FakeResponseRow;
  answers: VolputasSurveyAnswer[];
}

interface FakeDatabaseHarness {
  database: Database;
  events: string[];
  readState(): FakeState;
  transaction: ReturnType<typeof vi.fn>;
}

function createReadDatabase(rows: Array<{
  surveyId: string;
  submittedAt: Date;
  questionId: string | null;
  answerText: string | null;
  answerInt: number | null;
}>) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));
  return {
    database: { select } as unknown as Database,
    select,
    leftJoin,
  };
}

function cloneState(state: FakeState): FakeState {
  return {
    response: {
      ...state.response,
      submittedAt: new Date(state.response.submittedAt.getTime()),
      updatedAt: new Date(state.response.updatedAt.getTime()),
    },
    answers: state.answers.map((answer) => ({ ...answer })),
  };
}

function createFakeDatabase({ failAnswerInsert = false } = {}): FakeDatabaseHarness {
  let committedState: FakeState = {
    response: {
      id: RESPONSE_ID,
      surveyId: SURVEY_ID,
      userId: USER_ID,
      submittedAt: PREVIOUS_SUBMITTED_AT,
      updatedAt: PREVIOUS_SUBMITTED_AT,
    },
    answers: [{ questionId: "old_comment", textValue: "previous value" }],
  };
  const events: string[] = [];

  const transaction = vi.fn(async (
    work: (transactionClient: unknown) => Promise<unknown>,
  ) => {
    const workingState = cloneState(committedState);
    const transactionClient = {
      insert(table: unknown) {
        if (table === schema.volputasSurveyResponses) {
          return {
            values(value: {
              surveyId: string;
              userId: string;
              submittedAt: Date;
              updatedAt: Date;
            }) {
              return {
                onConflictDoUpdate() {
                  return {
                    async returning() {
                      events.push("upsert-response");
                      workingState.response = {
                        id: RESPONSE_ID,
                        ...value,
                      };
                      return [{ id: RESPONSE_ID }];
                    },
                  };
                },
              };
            },
          };
        }
        if (table === schema.volputasSurveyAnswers) {
          return {
            async values(values: Array<{
              questionId: string;
              answerText: string | null;
              answerInt: number | null;
            }>) {
              events.push("insert-answers");
              if (failAnswerInsert) throw new Error("simulated answer insert failure");
              workingState.answers = values.map((value) => (
                value.answerText !== null
                  ? { questionId: value.questionId, textValue: value.answerText }
                  : { questionId: value.questionId, intValue: value.answerInt as number }
              ));
            },
          };
        }
        throw new Error("unexpected insert table");
      },
      delete(table: unknown) {
        if (table !== schema.volputasSurveyAnswers) {
          throw new Error("unexpected delete table");
        }
        return {
          async where() {
            events.push("delete-old-answers");
            workingState.answers = [];
          },
        };
      },
    };

    try {
      const result = await work(transactionClient);
      committedState = workingState;
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  });

  return {
    database: { transaction } as unknown as Database,
    events,
    readState: () => cloneState(committedState),
    transaction,
  };
}

function replacementInput(): PersistedVolputasSurveyResponseInput {
  return {
    userId: USER_ID,
    surveyId: SURVEY_ID,
    submittedAt: NEXT_SUBMITTED_AT,
    answers: [
      { questionId: "rating", intValue: 5 },
      { questionId: "comment", textValue: "replacement value" },
    ],
  };
}

describe("Volputas survey response repository", () => {
  it("reads the response header and answers from one consistent query", async () => {
    const harness = createReadDatabase([
      {
        surveyId: SURVEY_ID,
        submittedAt: NEXT_SUBMITTED_AT,
        questionId: "comment",
        answerText: "current value",
        answerInt: null,
      },
      {
        surveyId: SURVEY_ID,
        submittedAt: NEXT_SUBMITTED_AT,
        questionId: "rating",
        answerText: null,
        answerInt: 5,
      },
    ]);
    const repository = createVolputasSurveyResponseRepository(harness.database);

    await expect(repository.findResponse(USER_ID, SURVEY_ID)).resolves.toEqual({
      surveyId: SURVEY_ID,
      submittedAt: NEXT_SUBMITTED_AT.toISOString(),
      answers: [
        { questionId: "comment", textValue: "current value" },
        { questionId: "rating", intValue: 5 },
      ],
    });
    expect(harness.select).toHaveBeenCalledTimes(1);
    expect(harness.leftJoin).toHaveBeenCalledTimes(1);
  });

  it("represents a response with no answers from the LEFT JOIN row", async () => {
    const harness = createReadDatabase([{
      surveyId: SURVEY_ID,
      submittedAt: NEXT_SUBMITTED_AT,
      questionId: null,
      answerText: null,
      answerInt: null,
    }]);
    const repository = createVolputasSurveyResponseRepository(harness.database);

    await expect(repository.findResponse(USER_ID, SURVEY_ID)).resolves.toEqual({
      surveyId: SURVEY_ID,
      submittedAt: NEXT_SUBMITTED_AT.toISOString(),
      answers: [],
    });
  });

  it("replaces every answer in one transaction and updates submission time", async () => {
    const harness = createFakeDatabase();
    const repository = createVolputasSurveyResponseRepository(harness.database);

    await expect(repository.replaceResponse(replacementInput())).resolves.toEqual({
      surveyId: SURVEY_ID,
      answers: replacementInput().answers,
      submittedAt: NEXT_SUBMITTED_AT.toISOString(),
    });
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([
      "upsert-response",
      "delete-old-answers",
      "insert-answers",
      "commit",
    ]);
    expect(harness.readState()).toMatchObject({
      response: {
        submittedAt: NEXT_SUBMITTED_AT,
        updatedAt: NEXT_SUBMITTED_AT,
      },
      answers: replacementInput().answers,
    });
  });

  it("rolls back the response upsert and answer deletion when insertion fails", async () => {
    const harness = createFakeDatabase({ failAnswerInsert: true });
    const repository = createVolputasSurveyResponseRepository(harness.database);
    const before = harness.readState();

    await expect(repository.replaceResponse(replacementInput()))
      .rejects.toThrow(/simulated answer insert failure/);
    expect(harness.events).toEqual([
      "upsert-response",
      "delete-old-answers",
      "insert-answers",
      "rollback",
    ]);
    expect(harness.readState()).toEqual(before);
  });
});
