import { describe, expect, it } from "vitest";
import { formatDevQueryParams } from "../../src/logging/dev-logger.js";

const ANSWER_CANARY = "answer-canary-must-not-reach-logs";

describe("development SQL parameter logging", () => {
  it.each([
    'insert into "volputas_survey_answers" ("answer_text") values ($1)',
    'update "volputas_survey_responses" set "user_id" = $1',
  ])("redacts every parameter for sensitive relation queries", (query) => {
    const output = formatDevQueryParams(query, [ANSWER_CANARY, "other-value"]);
    expect(output).toContain("[REDACTED count=2]");
    expect(output).not.toContain(ANSWER_CANARY);
    expect(output).not.toContain("other-value");
  });

  it("preserves existing diagnostic parameters for non-sensitive queries", () => {
    expect(formatDevQueryParams("select * from service_registry where id = $1", ["svc"]))
      .toContain("svc");
  });
});
