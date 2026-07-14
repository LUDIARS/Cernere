import { describe, expect, it } from "vitest";
import { isRelayBlockedByOptout } from "../../src/project/relay-service.js";

describe("isRelayBlockedByOptout", () => {
  it("allows relay when the user has not opted out of either endpoint", () => {
    expect(isRelayBlockedByOptout(new Set(), "actio", "imperativus")).toBe(false);
    expect(isRelayBlockedByOptout(new Set(["other"]), "actio", "imperativus")).toBe(false);
  });

  it("blocks relay when the user opted out of the source project", () => {
    expect(isRelayBlockedByOptout(new Set(["actio"]), "actio", "imperativus")).toBe(true);
  });

  it("blocks relay when the user opted out of the target project", () => {
    expect(isRelayBlockedByOptout(new Set(["imperativus"]), "actio", "imperativus")).toBe(true);
  });

  it("blocks relay when opted out of both", () => {
    expect(isRelayBlockedByOptout(new Set(["actio", "imperativus"]), "actio", "imperativus")).toBe(true);
  });
});
