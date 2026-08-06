import { describe, expect, it, vi } from "vitest";
import { toUserDataParameter } from "../../src/project/user-data-parameter.js";

describe("managed-project user data parameter binding", () => {
  it.each(["json", "jsonb"])("preserves the JSON shape for %s columns", (type) => {
    const value = [{ id: "voice-1", nested: { score: 2 } }];
    const marker = { jsonb: value };
    const json = vi.fn(() => marker);

    expect(toUserDataParameter({ json }, value, type)).toBe(marker);
    expect(json).toHaveBeenCalledWith(value);
    expect(json.mock.calls[0][0]).not.toBe(JSON.stringify(value));
  });

  it("leaves non-JSON column values unchanged", () => {
    const json = vi.fn();
    expect(toUserDataParameter({ json }, "plain text", "text")).toBe("plain text");
    expect(json).not.toHaveBeenCalled();
  });
});
