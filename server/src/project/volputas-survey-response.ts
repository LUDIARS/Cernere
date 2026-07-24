import {
  getResponseInputSchema,
  listResponseStatusesInputSchema,
  saveResponseInputSchema,
  type VolputasSurveyResponse,
} from "./volputas-survey-response-contract.js";
import {
  volputasSurveyResponseRepository,
  type VolputasSurveyResponseRepository,
} from "./volputas-survey-response-repository.js";

interface VolputasSurveyResponseServiceOptions {
  repository?: VolputasSurveyResponseRepository;
  now?: () => Date;
}

export interface VolputasSurveyResponseService {
  listResponseStatuses(value: unknown): Promise<{ answeredSurveyIds: string[] }>;
  getResponse(value: unknown): Promise<VolputasSurveyResponse | null>;
  saveResponse(value: unknown): Promise<VolputasSurveyResponse>;
}

export function createVolputasSurveyResponseService({
  repository = volputasSurveyResponseRepository,
  now = () => new Date(),
}: VolputasSurveyResponseServiceOptions = {}): VolputasSurveyResponseService {
  return {
    async listResponseStatuses(value) {
      const input = listResponseStatusesInputSchema.parse(value);
      const answeredSurveyIds = await repository.listAnsweredSurveyIds(
        input.userId,
        input.surveyIds,
      );
      return { answeredSurveyIds };
    },

    async getResponse(value) {
      const input = getResponseInputSchema.parse(value);
      return repository.findResponse(input.userId, input.surveyId);
    },

    async saveResponse(value) {
      const input = saveResponseInputSchema.parse(value);
      const submittedAt = now();
      if (!Number.isFinite(submittedAt.getTime())) {
        throw new Error("Volputas survey response clock returned an invalid date");
      }
      return repository.replaceResponse({
        ...input,
        submittedAt: new Date(submittedAt.getTime()),
      });
    },
  };
}

const defaultService = createVolputasSurveyResponseService();

export function listResponseStatuses(
  value: unknown,
): Promise<{ answeredSurveyIds: string[] }> {
  return defaultService.listResponseStatuses(value);
}

export function getResponse(value: unknown): Promise<VolputasSurveyResponse | null> {
  return defaultService.getResponse(value);
}

export function saveResponse(value: unknown): Promise<VolputasSurveyResponse> {
  return defaultService.saveResponse(value);
}
