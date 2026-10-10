import { describe, it, expect } from "vitest";
import { compositeWsPath, compositeWsUrl } from "../../src/auth/composite-ws-url";

const TICKET = "3f2b8c1e-0d4a-4b7e-9c55-1a2b3c4d5e6f";

describe("auth/composite-ws-url", () => {
  it("wsPath is the relative composite-ws path", () => {
    expect(compositeWsPath(TICKET)).toBe(`/auth/composite-ws?ticket=${TICKET}`);
  });

  it("wsUrl uses the public FRONTEND_URL with ws(s)", () => {
    expect(compositeWsUrl(TICKET, "https://cr.example.com")).toBe(`wss://cr.example.com/auth/composite-ws?ticket=${TICKET}`);
    expect(compositeWsUrl(TICKET, "http://localhost:5173/")).toBe(`ws://localhost:5173/auth/composite-ws?ticket=${TICKET}`);
  });

  it("ignores a path on FRONTEND_URL (the WS lives at the root)", () => {
    expect(compositeWsUrl(TICKET, "https://cr.example.com/app/")).toBe(`wss://cr.example.com/auth/composite-ws?ticket=${TICKET}`);
  });

  it("returns null for an unusable FRONTEND_URL", () => {
    expect(compositeWsUrl(TICKET, "not a url")).toBeNull();
    expect(compositeWsUrl(TICKET, "ftp://cr.example.com")).toBeNull();
  });
});
