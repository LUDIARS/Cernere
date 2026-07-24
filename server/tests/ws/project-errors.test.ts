import { describe, expect, it } from "vitest";
import { publicProjectCommandError } from "../../src/ws/project-errors.js";

describe("project command public errors", () => {
  it("never reflects a Volputas survey answer from an internal error", () => {
    const canary = "private-answer-canary";
    const message = publicProjectCommandError(
      "volputas_survey",
      new Error(`database rejected ${canary}`),
    );

    expect(message).toBe("Volputas survey command failed");
    expect(message).not.toContain(canary);
  });

  it("keeps the existing message contract for unrelated project modules", () => {
    expect(publicProjectCommandError("profile", new Error("missing user")))
      .toBe("missing user");
  });
});
