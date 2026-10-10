import { describe, expect, it } from "vitest";
import { publicProjectCommandError } from "../../src/ws/project-errors.js";

describe("project command public errors", () => {
  it("never reflects a Voluptas survey answer from an internal error", () => {
    const canary = "private-answer-canary";
    const message = publicProjectCommandError(
      "voluptas_survey",
      new Error(`database rejected ${canary}`),
    );

    expect(message).toBe("Voluptas survey command failed");
    expect(message).not.toContain(canary);
  });

  it("keeps the existing message contract for unrelated project modules", () => {
    expect(publicProjectCommandError("profile", new Error("missing user")))
      .toBe("missing user");
  });
});
