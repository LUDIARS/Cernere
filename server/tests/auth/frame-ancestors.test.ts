import { afterEach, describe, expect, it, vi } from "vitest";
import { frameAncestorsPolicy, compositeFramePolicy } from "../../../frontend/frame-ancestors";

describe("Composite frame ancestors", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([true, false])("enforces policy or fails closed (available: %s)", async available => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!available) throw new Error("offline");
      return Response.json({ origins: ["https://glab.example"] });
    }));
    let middleware: any;
    const plugin = compositeFramePolicy("http://localhost:8080");
    (plugin.configurePreviewServer as Function)({ middlewares: { use(fn: unknown) { middleware = fn; } } });
    const headers: Record<string, string> = {};
    let continued = false;
    const response = { statusCode: 200, setHeader(key: string, value: string) { headers[key] = value; }, end: () => {} };
    await new Promise<void>(resolve => {
      response.end = resolve;
      middleware({}, response, () => { continued = true; resolve(); });
    });
    expect(continued).toBe(available);
    expect(response.statusCode).toBe(available ? 200 : 503);
    expect(headers["Content-Security-Policy"]).toBe(available ? "frame-ancestors 'self' https://glab.example" : "frame-ancestors 'none'");
  });
  it("only emits exact configured origins", () => {
    expect(frameAncestorsPolicy(["https://glab.example", "https://glab.example"])).toBe("frame-ancestors 'self' https://glab.example");
  });
  it.each([undefined, [], ["*"], ["null"], ["https://glab.example/path"], ["https://glab.example; script-src *"], ["data:text/html,x"]])("rejects malformed policy %j", value => {
    expect(() => frameAncestorsPolicy(value)).toThrow();
  });
  it("installs the same boundary in development and preview", () => {
    const plugin = compositeFramePolicy("http://localhost:8080");
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.configurePreviewServer).toBe("function");
  });
});
