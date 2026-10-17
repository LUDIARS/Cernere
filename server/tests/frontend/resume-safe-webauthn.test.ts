import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), register: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: mocks.authenticate, startRegistration: mocks.register,
}));
import { isWebAuthnActive, startAuthentication, startRegistration } from "../../../packages/composite/src/ui/resume-safe-webauthn";

describe("native authentication reload guard", () => {
  it("keeps the guard until every overlapping ceremony settles, including rejection", async () => {
    let finish!: (value: unknown) => void;
    let cancel!: (reason: Error) => void;
    mocks.authenticate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mocks.register.mockImplementation(() => new Promise((_, reject) => { cancel = reject; }));
    const auth = startAuthentication({ optionsJSON: { challenge: "challenge" } });
    const registration = startRegistration({ optionsJSON: {} as never });
    expect(isWebAuthnActive()).toBe(true);
    finish({}); await auth;
    expect(isWebAuthnActive()).toBe(true);
    const rejected = expect(registration).rejects.toThrow("cancelled");
    cancel(new Error("cancelled")); await rejected;
    expect(isWebAuthnActive()).toBe(false);
  });
});
