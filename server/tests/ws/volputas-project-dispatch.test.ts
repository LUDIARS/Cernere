import { beforeEach, describe, expect, it, vi } from "vitest";

const listResponseStatuses = vi.fn();
const getResponse = vi.fn();
const saveResponse = vi.fn();

vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/project/volputas-survey-response.js", () => ({
  listResponseStatuses: (...args: unknown[]) => listResponseStatuses(...args),
  getResponse: (...args: unknown[]) => getResponse(...args),
  saveResponse: (...args: unknown[]) => saveResponse(...args),
}));

const { dispatchProjectCommand } =
  await import("../../src/ws/project-dispatch.js");

const USER_ID = "6f1d0b9b-179a-4fc7-a643-d3228fe350b2";
const SURVEY_ID = "53ce1ee5-0b08-4f71-9b7b-c9c424f09024";

describe("dispatchProjectCommand — Voluptas survey authorization", () => {
  beforeEach(() => {
    listResponseStatuses.mockReset().mockResolvedValue({ answeredSurveyIds: [] });
    getResponse.mockReset().mockResolvedValue(null);
    saveResponse.mockReset().mockResolvedValue({ surveyId: SURVEY_ID });
  });

  it("routes the three commands for the authenticated Voluptas project", async () => {
    const statusPayload = { userId: USER_ID, surveyIds: [SURVEY_ID] };
    const getPayload = { userId: USER_ID, surveyId: SURVEY_ID };
    const savePayload = {
      ...getPayload,
      answers: [{ questionId: "rating", intValue: 4 }],
    };

    await dispatchProjectCommand(
      "voluptas",
      "voluptas_survey",
      "list_response_statuses",
      statusPayload,
    );
    await dispatchProjectCommand(
      "voluptas",
      "voluptas_survey",
      "get_response",
      getPayload,
    );
    await dispatchProjectCommand(
      "voluptas",
      "voluptas_survey",
      "save_response",
      savePayload,
    );

    expect(listResponseStatuses).toHaveBeenCalledWith(statusPayload);
    expect(getResponse).toHaveBeenCalledWith(getPayload);
    expect(saveResponse).toHaveBeenCalledWith(savePayload);
  });

  it("rejects the retired volputas project key and module name", async () => {
    const payload = { userId: USER_ID, surveyId: SURVEY_ID, surveyIds: [SURVEY_ID], answers: [] };
    // 063 で key を改名した。旧綴りの key ではアンケートに触れない (別名は作らない)。
    await expect(dispatchProjectCommand("volputas", "voluptas_survey", "get_response", payload))
      .rejects.toThrow(/require the Voluptas project/);
    await expect(dispatchProjectCommand("voluptas", "volputas_survey", "get_response", payload))
      .rejects.toThrow(/Unknown command/);
    expect(getResponse).not.toHaveBeenCalled();
  });

  it.each([
    "list_response_statuses",
    "get_response",
    "save_response",
  ])("rejects %s from every other project before service access", async (action) => {
    await expect(dispatchProjectCommand(
      "EducationLab",
      "voluptas_survey",
      action,
      { userId: USER_ID, surveyId: SURVEY_ID, surveyIds: [SURVEY_ID], answers: [] },
    )).rejects.toThrow(/require the Voluptas project/);

    expect(listResponseStatuses).not.toHaveBeenCalled();
    expect(getResponse).not.toHaveBeenCalled();
    expect(saveResponse).not.toHaveBeenCalled();
  });
});
