import { z } from "zod";

export const MAX_VOLPUTAS_SURVEY_ANSWERS = 100;
export const MAX_VOLPUTAS_SURVEY_IDS = 500;
export const MAX_VOLPUTAS_TEXT_ANSWER_LENGTH = 4_000;

const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const uuidSchema = z.string().uuid();
const questionIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF)) return true;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

const textAnswerSchema = z.object({
  questionId: questionIdSchema,
  textValue: z.string().max(MAX_VOLPUTAS_TEXT_ANSWER_LENGTH)
    .refine(
      (value) => !value.includes("\u0000") && !hasUnpairedSurrogate(value),
      "text contains unsupported Unicode",
    ),
}).strict();

const integerAnswerSchema = z.object({
  questionId: questionIdSchema,
  intValue: z.number().int().min(POSTGRES_INTEGER_MIN).max(POSTGRES_INTEGER_MAX),
}).strict();

const answerSchema = z.union([textAnswerSchema, integerAnswerSchema]);

const answersSchema = z.array(answerSchema)
  .max(MAX_VOLPUTAS_SURVEY_ANSWERS)
  .superRefine((answers, context) => {
    const seenQuestionIds = new Set<string>();
    answers.forEach((answer, index) => {
      if (seenQuestionIds.has(answer.questionId)) {
        context.addIssue({
          code: "custom",
          message: "duplicate questionId",
          path: [index, "questionId"],
        });
      }
      seenQuestionIds.add(answer.questionId);
    });
  });

export const listResponseStatusesInputSchema = z.object({
  userId: uuidSchema,
  surveyIds: z.array(uuidSchema).max(MAX_VOLPUTAS_SURVEY_IDS),
}).strict();

export const getResponseInputSchema = z.object({
  userId: uuidSchema,
  surveyId: uuidSchema,
}).strict();

export const saveResponseInputSchema = z.object({
  userId: uuidSchema,
  surveyId: uuidSchema,
  answers: answersSchema,
}).strict();

export type VolputasSurveyAnswer = z.infer<typeof answerSchema>;
export type ListResponseStatusesInput = z.infer<typeof listResponseStatusesInputSchema>;
export type GetResponseInput = z.infer<typeof getResponseInputSchema>;
export type SaveResponseInput = z.infer<typeof saveResponseInputSchema>;

export interface VolputasSurveyResponse {
  surveyId: string;
  answers: VolputasSurveyAnswer[];
  submittedAt: string;
}

export interface PersistedVolputasSurveyResponseInput extends SaveResponseInput {
  submittedAt: Date;
}
