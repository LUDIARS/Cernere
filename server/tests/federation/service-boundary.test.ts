/**
 * サービスの口が連携番号で受け渡しすること (spec/plan/2026-10-15-account-federation-design.md §3 / §7)。
 *   - identity claim: サービスの番号で受け、値は主のアカウントから読む。逆引きの結果は番号で返す
 *   - OIDC: sub は番号、名前・メールは主のもの
 * DB と実 SQL は張らない (番号の解決はモック)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIMARY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// 連携 { SUBJECT (founder), DEVICE_B, PRIMARY }、主は PRIMARY。
vi.mock("../../src/federation/subject.js", () => ({
  primaryUserIdForSubject: async (id: string) => (id === SUBJECT ? PRIMARY : id),
  serviceSubjectId: async (id: string) => ([SUBJECT, DEVICE_B, PRIMARY].includes(id) ? SUBJECT : id),
}));

const mockManagedProjectRow = vi.fn();
vi.mock("../../src/db/connection.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(mockManagedProjectRow()) }) }) }) },
}));
const mockUnsafe = vi.fn();
vi.mock("postgres", () => ({ default: () => Object.assign(mockUnsafe, { unsafe: mockUnsafe, end: vi.fn() }) }));
vi.mock("../../src/config.js", () => ({ config: { databaseUrl: "postgres://test/test", oidcIssuer: "https://cernere.example.com" } }));
const mockDenied = vi.fn(async (_userId: string, _projectKey: string): Promise<Set<string>> => new Set());
vi.mock("../../src/consent/denials.js", () => ({ deniedPermissionKeys: mockDenied }));

const { getIdentityClaims, resolveUserByClaim } = await import("../../src/project/identity-claims.js");
const { buildClaims } = await import("../../src/oidc/scopes.js");

function projectRow() {
  return [{ key: "svc", isActive: true, schemaDefinition: { project: { key: "svc" }, identity_claims: ["discord_id"] } }];
}

beforeEach(() => {
  mockUnsafe.mockReset();
  mockUnsafe.unsafe = mockUnsafe;
  mockDenied.mockClear();
  mockManagedProjectRow.mockReturnValue(projectRow());
});

describe("identity claim", () => {
  it("サービスの番号で受け、値は主のアカウントから読む。拒否の判定は番号で行う", async () => {
    mockUnsafe.mockResolvedValue([{ discord_id: "42" }]);
    expect(await getIdentityClaims("svc", SUBJECT, ["discord_id"])).toEqual({ discord_id: "42" });
    expect(mockUnsafe.mock.calls[0][1]).toEqual([PRIMARY]);
    expect(mockDenied.mock.calls[0][0]).toBe(SUBJECT);
  });

  it("逆引きは連携のどのアカウントが当たっても連携番号を返す", async () => {
    mockUnsafe.mockResolvedValue([{ userId: DEVICE_B, displayName: "Neco" }]);
    expect(await resolveUserByClaim("svc", "discord_id", "42")).toEqual({ userId: SUBJECT, displayName: "Neco" });
  });
});

describe("OIDC claims", () => {
  it("sub と識別用メールは番号、名前は主のもの", () => {
    const claims = buildClaims({
      id: SUBJECT, email: null, displayName: "Primary", login: "primary", avatarUrl: null, hasVerifiedIdentity: false,
    }, ["openid", "email", "profile"], "https://cernere.example.com");
    expect(claims).toMatchObject({ sub: SUBJECT, name: "Primary", cr_access_email: `${SUBJECT}@users.cernere.example.com` });
  });
});
