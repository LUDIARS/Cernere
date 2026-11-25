import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  bearer: vi.fn(), jwt: vi.fn(), binding: vi.fn(), issue: vi.fn(), begin: vi.fn(),
  verify: vi.fn(), ticket: vi.fn(), user: vi.fn(), start: vi.fn(), policy: vi.fn(),
}));
vi.mock("../../src/auth/jwt.js", () => ({ extractBearerToken: m.bearer, verifyToken: m.jwt }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ resolveAuthCodeBinding: m.binding }));
vi.mock("../../src/auth/auth-code.js", () => ({ issueAuthCodeForUserId: m.issue }));
vi.mock("../../src/auth/mfa-challenge.js", () => ({ beginMfaChallenge: m.begin, verifyMfaChallenge: m.verify }));
vi.mock("../../src/auth/mfa-records.js", () => ({ readMfaTicket: m.ticket }));
vi.mock("../../src/auth/mfa-user.js", () => ({ loadMfaUser: m.user }));
vi.mock("../../src/auth/onsite-challenge.js", () => ({ startOnsiteChallenge: m.start }));
vi.mock("../../src/project/onsite-mfa-policy.js", () => ({ projectOnsiteRequirement: m.policy }));
vi.mock("../../src/consent/gate.js", () => ({ ConsentRequiredError: class extends Error {}, consentRequiredBody: vi.fn() }));

import { compositeOnsite } from "../../src/http/composite-onsite.js";

const input = { client_id: "client", code_challenge: "a".repeat(43), target: "https://hub.example",
  targetMode: "post_message", state: "b".repeat(43) };
const binding = { audience: "service", projectKey: "glab", codeChallenge: input.code_challenge, origin: input.target };
const requirement = { minAssurance: "high", allowedPlaceIds: ["school"] };
const source = { sub: "member", authEpoch: 2 };
beforeEach(() => {
  vi.resetAllMocks();
  m.bearer.mockReturnValue("bearer");
  m.jwt.mockResolvedValue(source);
  m.binding.mockResolvedValue(binding);
  m.policy.mockResolvedValue(requirement);
  m.begin.mockResolvedValue({ mfaToken: "ticket" });
  m.start.mockResolvedValue({ nonce: "nonce", kiosks: [] });
  m.ticket.mockResolvedValue({ record: { userId: source.sub, onsite: requirement } });
  m.verify.mockImplementation(async (_token, _method, _code, _context, complete) => complete({ id: source.sub }));
  m.issue.mockResolvedValue("authorization-code");
});

it("requires an authenticated browser, the GLAB audience and its explicit onsite policy", async () => {
  m.bearer.mockReturnValueOnce(null);
  await expect(compositeOnsite("begin", "", input)).rejects.toMatchObject({ statusCode: 401 });
  m.binding.mockResolvedValueOnce({ ...binding, projectKey: "other" });
  await expect(compositeOnsite("available", "auth", input)).resolves.toEqual({ available: false });
  m.policy.mockResolvedValue(null);
  await expect(compositeOnsite("available", "auth", input)).resolves.toEqual({ available: false });
  await expect(compositeOnsite("begin", "auth", input)).rejects.toMatchObject({ statusCode: 403 });
  expect(m.begin).not.toHaveBeenCalled();
});

it("binds the MFA ticket to the authorizing session, client, challenge, state and target", async () => {
  for (const request of [input, { ...input, client_id: "other-client" }, { ...input, state: "c".repeat(43) },
    { ...input, code_challenge: "d".repeat(43) }, { ...input, target: "https://other.example" }]) {
    await compositeOnsite("begin", "auth", request);
  }
  m.bearer.mockReturnValue("another-bearer");
  await compositeOnsite("begin", "auth", input);
  const contexts = m.begin.mock.calls.map(call => call[1].binding);
  expect(new Set(contexts).size).toBe(contexts.length);
  expect(m.issue).not.toHaveBeenCalled();
});

it("does not issue a code after a policy change or for a different kiosk subject", async () => {
  const finish = { ...input, mfaToken: "ticket" };
  m.policy.mockResolvedValueOnce({ minAssurance: "high", allowedPlaceIds: ["another-campus"] });
  await expect(compositeOnsite("finish", "auth", finish)).rejects.toMatchObject({ statusCode: 403 });
  m.ticket.mockResolvedValueOnce({ record: { userId: "different-account", onsite: requirement } });
  await expect(compositeOnsite("finish", "auth", finish)).rejects.toMatchObject({ statusCode: 403 });
  expect(m.verify).not.toHaveBeenCalled();
  expect(m.issue).not.toHaveBeenCalled();
});

it("issues through the existing service consent and PKCE path only after onsite completion", async () => {
  await expect(compositeOnsite("finish", "auth", { ...input, mfaToken: "ticket" })).resolves.toEqual({ authCode: "authorization-code" });
  expect(m.verify).toHaveBeenCalledWith("ticket", "onsite", "", expect.objectContaining({ projectKey: "glab" }), expect.any(Function));
  expect(m.issue).toHaveBeenCalledWith(source.sub, { subject: { projectKey: "glab" }, authCodeBinding: binding, channel: "browser",
    continuation: { mode: "post_message", target: input.target, state: input.state } }, source);
});
