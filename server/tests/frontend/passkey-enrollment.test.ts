import { describe, expect, it } from "vitest";
import { passkeyEnrollmentUrl, shouldOfferPcEnrollment } from "../../../frontend/src/lib/passkey-enrollment";

const origin = "https://cernere.example.com";

describe("PC passkey enrollment navigation", () => {
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
});
