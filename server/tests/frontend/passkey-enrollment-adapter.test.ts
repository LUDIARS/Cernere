import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

const exchange = vi.hoisted(() => vi.fn());
const mobile = vi.hoisted(() => vi.fn());
vi.mock("../../../frontend/src/lib/api", () => ({ auth: { exchangeAuthCode: exchange } }));
vi.mock("../../../frontend/src/lib/device-kind", () => ({ isMobileDevice: mobile }));
import { CernereCompositeAuthAdapter } from "../../../frontend/src/lib/composite-auth-adapter";

const target = "https://glab.example.com";
const returnTo = "/composite/login?origin=https%3A%2F%2Fglab.example.com";
const assign = vi.fn();
const fetchMock = vi.fn();

function params(attachment: "platform" | "cross-platform") {
  return { challengeOwner: "challenge-owner", response: { authenticatorAttachment: attachment } as AuthenticationResponseJSON };
}

beforeEach(() => {
  vi.clearAllMocks();
  mobile.mockReturnValue(false);
  exchange.mockResolvedValue({});
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ authCode: "one-time-code" }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { origin: "https://cernere.example.com", assign } });
});
afterEach(() => vi.unstubAllGlobals());

describe("enrollment authentication boundary", () => {
  it("exchanges only a Cernere code and never delivers the consumed code to the service", async () => {
    const adapter = new CernereCompositeAuthAdapter("", target, "post_message", false, returnTo);
    const delivered = vi.fn();
    void adapter.passkeyLoginFinish(params("cross-platform")).then(delivered);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("target");
    expect(exchange).toHaveBeenCalledExactlyOnceWith("one-time-code");
    expect(delivered).not.toHaveBeenCalled();
    const next = new URL(assign.mock.calls[0][0], "https://cernere.example.com");
    expect(next.pathname).toBe("/passkeys/register");
    expect(next.searchParams.get("return")).toBe(returnTo);
  });

  it.each([false, true])("preserves service targeting for a local credential (mobile=%s)", async (isMobile) => {
    mobile.mockReturnValue(isMobile);
    const adapter = new CernereCompositeAuthAdapter("", target, "redirect", false, returnTo);
    expect(await adapter.passkeyLoginFinish(params("platform"))).toEqual({ authCode: "one-time-code" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ target, targetMode: "redirect" });
    expect(exchange).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not divert a mobile external-authenticator login", async () => {
    mobile.mockReturnValue(true);
    const adapter = new CernereCompositeAuthAdapter("", target, "post_message", false, returnTo);
    expect(await adapter.passkeyLoginFinish(params("cross-platform"))).toEqual({ authCode: "one-time-code" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveProperty("target", target);
  });

  it("stops before navigation when the internal code exchange fails", async () => {
    exchange.mockRejectedValue(new Error("exchange rejected"));
    const adapter = new CernereCompositeAuthAdapter("", target, "post_message", false, returnTo);
    await expect(adapter.passkeyLoginFinish(params("cross-platform"))).rejects.toThrow("exchange rejected");
    expect(assign).not.toHaveBeenCalled();
  });
});
