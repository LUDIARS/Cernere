import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
const exchange = vi.hoisted(() => vi.fn());
const mobile = vi.hoisted(() => vi.fn());
vi.mock("../../../frontend/src/lib/api", () => ({ auth: { exchangeAuthCode: exchange } }));
vi.mock("../../../frontend/src/lib/device-kind", () => ({ isMobileDevice: mobile }));
import { CernereCompositeAuthAdapter } from "../../../frontend/src/lib/composite-auth-adapter";

const target = "https://glab.example.com";
const query = `?client_id=glab&code_challenge=${"c".repeat(43)}&state=${"s".repeat(43)}`;
const returnTo = `/composite/login${query}&origin=${encodeURIComponent(target)}`;
const assign = vi.fn();
const fetchMock = vi.fn();
function params(attachment: "platform" | "cross-platform") {
  return { challengeOwner: "challenge-owner", response: { authenticatorAttachment: attachment } as AuthenticationResponseJSON };
}
beforeEach(() => {
  vi.clearAllMocks();
  mobile.mockReturnValue(false);
  exchange.mockResolvedValue({});
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith("-begin")
    ? { challengeOwner: "challenge-owner", options: {} } : { authCode: "one-time-code" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { origin: "https://cernere.example.com", search: query, assign } });
  vi.stubGlobal("document", { cookie: "" });
});
afterEach(() => vi.unstubAllGlobals());

describe("enrollment authentication boundary", () => {
  it("preserves service authorization after device addition is dismissed", async () => {
    vi.stubGlobal("document", { cookie: "cernere_hide_device_enrollment=1" });
    const adapter = new CernereCompositeAuthAdapter("", target, "redirect", true, returnTo);
    await adapter.passkeyLoginBegin();
    expect(await adapter.passkeyLoginFinish(params("cross-platform"))).toEqual({ authCode: "one-time-code" });
    const begin = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(begin).toMatchObject({ target, targetMode: "redirect" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject(begin);
    expect(exchange).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it.each(["platform", "cross-platform"] as const)("starts a new self ceremony for requested enrollment (%s)", async attachment => {
    const adapter = new CernereCompositeAuthAdapter("", target, "redirect", true, returnTo);
    await adapter.passkeyLoginBegin();
    const delivered = vi.fn();
    void adapter.passkeyLoginFinish(params(attachment)).then(delivered);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(1); // No finish changes a service challenge to self.
    expect(exchange).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    const next = new URL(assign.mock.calls[0][0], window.location.origin);
    expect(next.pathname).toBe("/login");
    const enrollment = new URL(next.searchParams.get("redirect")!, window.location.origin);
    expect(enrollment.pathname).toBe("/passkeys/register");
    expect(enrollment.searchParams.get("return")).toBe(returnTo);
  });
  it("keeps a self challenge as self before enrollment", async () => {
    const adapter = new CernereCompositeAuthAdapter("", null, "post_message", false, "/profile");
    await adapter.passkeyLoginBegin();
    void adapter.passkeyLoginFinish(params("cross-platform"));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("target");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("target");
    expect(exchange).toHaveBeenCalledExactlyOnceWith("one-time-code", expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
  });
  it.each([false, true])("preserves service targeting for a local credential (mobile=%s)", async isMobile => {
    mobile.mockReturnValue(isMobile);
    const adapter = new CernereCompositeAuthAdapter("", target, "redirect", false, returnTo);
    await adapter.passkeyLoginBegin();
    expect(await adapter.passkeyLoginFinish(params("platform"))).toEqual({ authCode: "one-time-code" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ target, targetMode: "redirect" });
    expect(exchange).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it("does not re-read a changed query during completion", async () => {
    const adapter = new CernereCompositeAuthAdapter("", target, "post_message", false, null);
    await adapter.passkeyLoginBegin();
    window.location.search = "?client_id=other";
    await adapter.passkeyLoginFinish(params("platform"));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ client_id: "glab", code_challenge: "c".repeat(43) });
  });
  it("requires a matching begin and consumes local completion state once", async () => {
    const adapter = new CernereCompositeAuthAdapter("", target, "post_message", false, null);
    await expect(adapter.passkeyLoginFinish(params("platform"))).rejects.toThrow("Start a new");
    await adapter.passkeyLoginBegin();
    await adapter.passkeyLoginFinish(params("platform"));
    await expect(adapter.passkeyLoginFinish(params("platform"))).rejects.toThrow("Start a new");
  });
  it("stops before navigation when the internal self exchange fails", async () => {
    exchange.mockRejectedValue(new Error("exchange rejected"));
    const adapter = new CernereCompositeAuthAdapter("", null, "post_message", false, "/profile");
    await adapter.passkeyLoginBegin();
    await expect(adapter.passkeyLoginFinish(params("cross-platform"))).rejects.toThrow("exchange rejected");
    expect(assign).not.toHaveBeenCalled();
  });
  it("cancels owned requests on unmount", async () => {
    const adapter = new CernereCompositeAuthAdapter("", target, "post_message", false, null);
    await adapter.passkeyLoginBegin();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    adapter.dispose();
    expect(signal.aborted).toBe(true);
    await expect(adapter.passkeyLoginFinish(params("platform"))).rejects.toThrow();
  });
});
