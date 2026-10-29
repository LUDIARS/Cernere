import { describe, expect, it, vi } from "vitest";

vi.mock("uWebSockets.js", () => ({ default: { App: vi.fn(), SSLApp: vi.fn() } }));

const { classifyError, isDatabaseError } = await import("../../src/app.js");
const { AppError } = await import("../../src/error.js");

describe("classifyError", () => {
  it("never returns a database error's message, even when the input smuggles a 4xx keyword", () => {
    const err = new Error('Failed query: select "id" from "users" where "users"."email" = $1\nparams: \u0000Unauthorized,1');
    err.name = "DrizzleQueryError";
    expect(isDatabaseError(err)).toBe(true);
    expect(classifyError(err)).toEqual({ status: "500 Internal Server Error", message: "Internal server error" });
  });

  it("treats pg errors carrying an SQLSTATE as database errors", () => {
    const pg = Object.assign(new Error("invalid byte sequence for encoding \"UTF8\": 0x00 Unauthorized"), { code: "22021" });
    const wrapped = Object.assign(new Error("Unauthorized something"), { cause: pg });
    expect(isDatabaseError(pg)).toBe(true);
    expect(isDatabaseError(wrapped)).toBe(true);
    expect(classifyError(wrapped).status).toBe("500 Internal Server Error");
  });

  it("keeps mapping application errors and known messages", () => {
    expect(classifyError(AppError.badRequest("Invalid Host header")).status).toBe("400 Bad Request");
    expect(classifyError(new Error("Unauthorized: passkey not registered")).status).toBe("401 Unauthorized");
    expect(isDatabaseError(new Error("Unauthorized"))).toBe(false);
    expect(isDatabaseError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
  });
});
