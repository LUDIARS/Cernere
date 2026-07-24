import { and, eq, inArray } from "drizzle-orm";
import { db, type Database } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type {
  PersistedVolputasSurveyResponseInput,
  VolputasSurveyAnswer,
  VolputasSurveyResponse,
} from "./volputas-survey-response-contract.js";

export interface VolputasSurveyResponseRepository {
  listAnsweredSurveyIds(userId: string, surveyIds: string[]): Promise<string[]>;
  findResponse(userId: string, surveyId: string): Promise<VolputasSurveyResponse | null>;
  replaceResponse(
    input: PersistedVolputasSurveyResponseInput,
  ): Promise<VolputasSurveyResponse>;
}

function mapStoredAnswer(row: {
  questionId: string;
  answerText: string | null;
  answerInt: number | null;
}): VolputasSurveyAnswer {
  if (row.answerText !== null && row.answerInt === null) {
    return { questionId: row.questionId, textValue: row.answerText };
  }
  if (row.answerText === null && row.answerInt !== null) {
    return { questionId: row.questionId, intValue: row.answerInt };
  }
  throw new Error("Stored Volputas survey answer violates the exactly-one invariant");
}

export function createVolputasSurveyResponseRepository(
  database: Database = db,
): VolputasSurveyResponseRepository {
  return {
    async listAnsweredSurveyIds(userId, surveyIds) {
      if (surveyIds.length === 0) return [];
      const rows = await database
        .select({ surveyId: schema.volputasSurveyResponses.surveyId })
        .from(schema.volputasSurveyResponses)
        .where(and(
          eq(schema.volputasSurveyResponses.userId, userId),
          inArray(schema.volputasSurveyResponses.surveyId, surveyIds),
        ));
      return rows.map((row) => row.surveyId);
    },

    async findResponse(userId, surveyId) {
      const rows = await database
        .select({
          surveyId: schema.volputasSurveyResponses.surveyId,
          submittedAt: schema.volputasSurveyResponses.submittedAt,
          questionId: schema.volputasSurveyAnswers.questionId,
          answerText: schema.volputasSurveyAnswers.answerText,
          answerInt: schema.volputasSurveyAnswers.answerInt,
        })
        .from(schema.volputasSurveyResponses)
        .leftJoin(
          schema.volputasSurveyAnswers,
          eq(
            schema.volputasSurveyAnswers.responseId,
            schema.volputasSurveyResponses.id,
          ),
        )
        .where(and(
          eq(schema.volputasSurveyResponses.userId, userId),
          eq(schema.volputasSurveyResponses.surveyId, surveyId),
        ))
        .orderBy(schema.volputasSurveyAnswers.questionId);
      const response = rows[0];
      if (!response) return null;

      return {
        surveyId: response.surveyId,
        submittedAt: response.submittedAt.toISOString(),
        answers: rows.flatMap((row) => (
          row.questionId === null
            ? []
            : [mapStoredAnswer({
              questionId: row.questionId,
              answerText: row.answerText,
              answerInt: row.answerInt,
            })]
        )),
      };
    },

    async replaceResponse(input) {
      return database.transaction(async (transaction) => {
        const responses = await transaction
          .insert(schema.volputasSurveyResponses)
          .values({
            surveyId: input.surveyId,
            userId: input.userId,
            submittedAt: input.submittedAt,
            updatedAt: input.submittedAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.volputasSurveyResponses.surveyId,
              schema.volputasSurveyResponses.userId,
            ],
            set: {
              submittedAt: input.submittedAt,
              updatedAt: input.submittedAt,
            },
          })
          .returning({ id: schema.volputasSurveyResponses.id });
        const responseId = responses[0]?.id;
        if (!responseId) {
          throw new Error("Cernere failed to persist the Volputas survey response");
        }

        await transaction
          .delete(schema.volputasSurveyAnswers)
          .where(eq(schema.volputasSurveyAnswers.responseId, responseId));

        if (input.answers.length > 0) {
          await transaction.insert(schema.volputasSurveyAnswers).values(
            input.answers.map((answer) => ({
              responseId,
              questionId: answer.questionId,
              answerText: "textValue" in answer ? answer.textValue : null,
              answerInt: "intValue" in answer ? answer.intValue : null,
            })),
          );
        }

        return {
          surveyId: input.surveyId,
          answers: input.answers,
          submittedAt: input.submittedAt.toISOString(),
        };
      });
    },
  };
}

export const volputasSurveyResponseRepository =
  createVolputasSurveyResponseRepository();
