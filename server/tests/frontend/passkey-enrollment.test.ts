import { afterEach, describe, expect, it, vi } from "vitest";
import { passkeyEnrollmentUrl, shouldOfferPcEnrollment, skipDeviceEnrollmentUrl } from "../../../frontend/src/lib/passkey-enrollment";

const origin = "https://cernere.example.com";
afterEach(() => vi.unstubAllGlobals());

describe("PC passkey enrollment navigation", () => {
  it("skips only the display prompt while preserving service authorization parameters", () => {
    const next = new URL(skipDeviceEnrollmentUrl("/composite/login?origin=https%3A%2F%2Fglab.example", origin), origin);
    expect(next.searchParams.get("origin")).toBe("https://glab.example");
    expect(next.searchParams.get("device_add_skipped")).toBe("1");
    expect(skipDeviceEnrollmentUrl("//evil.example", origin)).toBe("/");
  });
  it("preserves the full service login destination through enrollment", () => {
    const target = "/composite/login?origin=https%3A%2F%2Fglab.example.com&cross_device=1";
    const url = new URL(passkeyEnrollmentUrl(target, origin), origin);
    expect(url.pathname).toBe("/passkeys/register");
    expect(url.searchParams.get("return")).toBe(target);
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example/", "/\n/evil.example/"])("rejects an external destination: %s", (target) => {
    const url = new URL(passkeyEnrollmentUrl(target, origin), origin);
    expect(url.searchParams.get("return")).toBe("/");
  });

  it("offers registration for an external authenticator on a PC only", () => {
    expect(shouldOfferPcEnrollment("cross-platform", false, "/profile", origin)).toBe(true);
    expect(shouldOfferPcEnrollment("cross-platform", true, "/profile", origin)).toBe(false);
    expect(shouldOfferPcEnrollment("platform", false, "/profile", origin)).toBe(false);
    expect(shouldOfferPcEnrollment(undefined, false, "/profile", origin)).toBe(false);
  });

  it("does not nest enrollment when login was already requested by the enrollment page", () => {
    expect(shouldOfferPcEnrollment("cross-platform", false, passkeyEnrollmentUrl("/profile", origin), origin)).toBe(false);
    expect(shouldOfferPcEnrollment("cross-platform", false, "/x/../passkeys/register?return=%2F", origin)).toBe(false);
  });

  it.each(["cernere_passkey_registered=1", "cernere_hide_device_enrollment=1"])("suppresses the automatic prompt for %s", cookie => {
    vi.stubGlobal("document", { cookie });
    expect(shouldOfferPcEnrollment("cross-platform", false, "/profile", origin, true)).toBe(false);
  });

  it("never prompts on mobile even when smartphone login was requested", () => {
    expect(shouldOfferPcEnrollment("cross-platform", true, "/profile", origin, true)).toBe(false);
  });
});
