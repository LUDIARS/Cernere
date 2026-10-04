import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEndpoint, resolveAgentToken } from "../../scripts/env/agent-endpoint.js";

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync }));
vi.mock("node:os", () => ({ homedir: () => "/fixture-home" }));
afterEach(() => vi.resetAllMocks());

describe("agent endpoint", () => {
  it("prefers URL over the explicit port and never guesses a default port", () => {
    expect(resolveAgentEndpoint({ EXCUBITOR_URL: "http://localhost:23456/", EXCUBITOR_PORT: "34567" }))
      .toBe("http://localhost:23456");
    expect(resolveAgentEndpoint({ EXCUBITOR_PORT: "34567" })).toBe("http://127.0.0.1:34567");
    expect(() => resolveAgentEndpoint({})).toThrow("script-env: no_endpoint");
  });
  it.each(["https://example.com", "http://secret:secret@localhost", "http://localhost/private", "secret"])(
    "rejects unsafe endpoints without echoing input", (url) => {
      expect(() => resolveAgentEndpoint({ EXCUBITOR_URL: url })).toThrow("script-env: no_endpoint");
    },
  );
});

describe("agent token precedence", () => {
  it("uses injected token without touching disk", () => {
    expect(resolveAgentToken({ EXCUBITOR_AGENT_TOKEN: " injected ", EXCUBITOR_AGENT_TOKEN_PATH: "/unused" })).toBe("injected");
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("reads the explicit UTF-8 file before the default", () => {
    readFileSync.mockReturnValue(" file-token\n");
    expect(resolveAgentToken({ EXCUBITOR_AGENT_TOKEN_PATH: "/explicit" })).toBe("file-token");
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith("/explicit", "utf8");
  });
  it.each([{ APPDATA: "/fixture-appdata" }, {}])("uses the same default as Actio", (env) => {
    readFileSync.mockReturnValue("default-token");
    expect(resolveAgentToken(env)).toBe("default-token");
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(
      join(env.APPDATA || join("/fixture-home", ".config"), "Excubitor", "secret-agent.token"), "utf8",
    );
  });
  it.each(["", " \n"])("rejects empty token files without fallback", (token) => {
    readFileSync.mockReturnValue(token);
    expect(() => resolveAgentToken({ EXCUBITOR_AGENT_TOKEN_PATH: "/private-path" })).toThrow("script-env: no_token");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
  it("sanitizes filesystem errors and does not try another path", () => {
    readFileSync.mockImplementation(() => { throw new Error("private-path token-value"); });
    expect(() => resolveAgentToken({ EXCUBITOR_AGENT_TOKEN_PATH: "/private-path" })).toThrow("script-env: no_token");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});
