/** SPEC-VOB-DISCORD-REGISTRATION: 署名・設定・トークン状態・interaction の判定順・signup の分岐。 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ consumed: true }));
vi.mock("../../src/vob/vob-token-store.js", () => ({
  readVobToken: async () => null,
  consumeVobToken: async () => store.consumed,
}));
vi.mock("../../src/db/connection.js", () => ({ db: {} }));

const schema = await import("../../src/db/schema.js");
const { verifyDiscordSignature } = await import("../../src/vob/discord-signature.js");
const { parseVobConfig } = await import("../../src/vob/vob-config.js");
const { vobTokenOutcome } = await import("../../src/vob/vob-token-state.js");
const { handleVobInteraction, VOB_MESSAGES } = await import("../../src/vob/vob-interactions.js");
const { applyVobSignup, precheckVobSignup, VOB_TOKEN_INVALID, VOB_REGISTRATION_REASON } = await import("../../src/vob/vob-registration-signup.js");
const { toSharedMember } = await import("../../src/vob/vob-shared-members.js");
const { accessReviewOrigin } = await import("../../src/auth/access-review-origin.js");
const { readVobToken: readLinkToken } = await import("../../../frontend/src/pages/onboarding/vob-link");
const { registrationOriginLabel } = await import("../../../frontend/src/pages/admin/access-review-origin");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "55555555-5555-4555-8555-555555555555";
const GUILD = "123456789012345678";
const DISCORD = "987654321098765432";
/** 本物の鍵に見えない、テスト用の固定値 (登録リンクの形式だけを満たす) */
const FAKE_LINK_VALUE = "x".repeat(32);

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_HEX = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex");
const INPUT = {
  enabled: true,
  applicationId: "111111111111111111",
  publicKeyHex: PUBLIC_HEX,
  botToken: "bot-token",
  guildId: GUILD,
  organizationId: ORG,
  adminChannelId: "222222222222222222",
  approvalWindowDays: 7,
};
const FRONTEND = "https://cr.example/";

afterEach(() => { vi.unstubAllEnvs(); store.consumed = true; });

function sign(timestamp: string, body: string): string {
  return crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
}

describe("Discord interaction signature", () => {
  const body = JSON.stringify({ type: 1 });
  const ts = String(Math.floor(NOW.getTime() / 1000));

  it("accepts a fresh, correctly signed body", () => {
    expect(verifyDiscordSignature({ publicKeyHex: PUBLIC_HEX, signatureHex: sign(ts, body), timestamp: ts, rawBody: body, nowSec: Number(ts) })).toBe(true);
  });

  it("rejects tampered bodies, stale timestamps and malformed signatures", () => {
    const sig = sign(ts, body);
    expect(verifyDiscordSignature({ publicKeyHex: PUBLIC_HEX, signatureHex: sig, timestamp: ts, rawBody: body + " ", nowSec: Number(ts) })).toBe(false);
    expect(verifyDiscordSignature({ publicKeyHex: PUBLIC_HEX, signatureHex: sig, timestamp: ts, rawBody: body, nowSec: Number(ts) + 301 })).toBe(false);
    expect(verifyDiscordSignature({ publicKeyHex: PUBLIC_HEX, signatureHex: "zz", timestamp: ts, rawBody: body, nowSec: Number(ts) })).toBe(false);
  });
});

describe("V.O.B config", () => {
  it("is enabled only when every value is present and well-formed", () => {
    const config = parseVobConfig(INPUT, FRONTEND);
    expect(config).toMatchObject({ guildId: GUILD, organizationId: ORG, frontendUrl: "https://cr.example", approvalWindowDays: 7 });
    expect(parseVobConfig({ ...INPUT, organizationId: "vob" }, FRONTEND)).toBeNull();
    expect(parseVobConfig({ ...INPUT, botToken: "" }, FRONTEND)).toBeNull();
    expect(parseVobConfig({ ...INPUT, publicKeyHex: "abc" }, FRONTEND)).toBeNull();
  });
});

describe("V.O.B token state", () => {
  const row = { id: "t1", discordUserId: DISCORD, discordUsername: "neko", organizationId: ORG, guildJoinedAt: null, expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: null, revokedAt: null, requiresApproval: false };
  it("only an unexpired, unconsumed, unrevoked token is usable", () => {
    expect(vobTokenOutcome(row, NOW)).toMatchObject({ kind: "usable", discordUserId: DISCORD, organizationId: ORG });
    expect(vobTokenOutcome(null, NOW).kind).toBe("invalid");
    expect(vobTokenOutcome({ ...row, consumedAt: NOW }, NOW).kind).toBe("invalid");
    expect(vobTokenOutcome({ ...row, revokedAt: NOW }, NOW).kind).toBe("invalid");
    expect(vobTokenOutcome({ ...row, expiresAt: NOW }, NOW).kind).toBe("invalid");
  });
});

describe("/register interaction", () => {
  const config = parseVobConfig({ ...INPUT, approvalWindowDays: 0 }, FRONTEND)!;
  const command = (over: Record<string, unknown> = {}) => ({ type: 2, guild_id: GUILD, data: { name: "register" }, member: { user: { id: DISCORD, username: "neko" } }, ...over });
  const deps = (over: Partial<Parameters<typeof handleVobInteraction>[1]> = {}) => ({
    config,
    isDiscordLinked: vi.fn(async () => false),
    fetchGuildMember: vi.fn(async () => ({ discordUserId: DISCORD, username: "neko", joinedAt: NOW })),
    issueToken: vi.fn(async () => ({ token: FAKE_LINK_VALUE, expiresAt: new Date(Date.now() + 30 * 60_000) })),
    notifyAdmins: vi.fn(),
    ...over,
  });

  it("answers Discord's PING", async () => {
    expect(await handleVobInteraction({ type: 1 }, deps())).toEqual({ type: 1 });
  });

  it("issues an ephemeral one-time link bound to the member, without firing mentions", async () => {
    const d = deps();
    const reply = await handleVobInteraction(command(), d);
    expect(reply.data?.flags).toBe(64);
    expect(reply.data?.allowed_mentions).toEqual({ parse: [] });
    expect(reply.data?.content).toContain(`https://cr.example/start?vob=${FAKE_LINK_VALUE}`);
    expect(d.issueToken).toHaveBeenCalledWith({ discordUserId: DISCORD, discordUsername: "neko", guildJoinedAt: NOW, organizationId: ORG, requiresApproval: false });
  });

  it("accepts the Japanese command name", async () => {
    const d = deps();
    await handleVobInteraction(command({ data: { name: "登録" } }), d);
    expect(d.issueToken).toHaveBeenCalled();
  });

  it("refuses other servers and DMs before touching the database", async () => {
    const d = deps();
    expect((await handleVobInteraction(command({ guild_id: "1" }), d)).data?.content).toBe(VOB_MESSAGES.wrongGuild);
    expect((await handleVobInteraction(command({ guild_id: undefined }), d)).data?.content).toBe(VOB_MESSAGES.wrongGuild);
    expect(d.isDiscordLinked).not.toHaveBeenCalled();
  });

  it("does not issue for an already-linked Discord account or a non-member", async () => {
    const linked = deps({ isDiscordLinked: vi.fn(async () => true) });
    expect((await handleVobInteraction(command(), linked)).data?.content).toBe(VOB_MESSAGES.alreadyLinked);
    expect(linked.issueToken).not.toHaveBeenCalled();
    const outsider = deps({ fetchGuildMember: vi.fn(async () => null) });
    expect((await handleVobInteraction(command(), outsider)).data?.content).toBe(VOB_MESSAGES.notMember);
    expect(outsider.issueToken).not.toHaveBeenCalled();
  });

  it("fails closed when Discord cannot be reached", async () => {
    const d = deps({ fetchGuildMember: vi.fn(async () => { throw new Error("down"); }) });
    expect((await handleVobInteraction(command(), d)).data?.content).toBe(VOB_MESSAGES.unavailable);
    expect(d.issueToken).not.toHaveBeenCalled();
  });
});

describe("signup with vobToken", () => {
  const usableRow = { id: "t1", discordUserId: DISCORD, discordUsername: "neko", organizationId: ORG, guildJoinedAt: null, expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: null, revokedAt: null, requiresApproval: false };
  const deps = (over = {}) => ({ loadConfig: async () => parseVobConfig(INPUT, FRONTEND), read: async () => usableRow, stillMember: async () => true, linkedElsewhere: async () => false, ...over });

  it("re-checks membership and linking at completion", async () => {
    await expect(precheckVobSignup("tok", NOW, deps())).resolves.toMatchObject({ discordUserId: DISCORD, organizationId: ORG });
    await expect(precheckVobSignup("tok", NOW, deps({ stillMember: async () => false }))).rejects.toMatchObject({ statusCode: 422, code: VOB_TOKEN_INVALID });
    await expect(precheckVobSignup("tok", NOW, deps({ stillMember: async () => { throw new Error("down"); } }))).rejects.toMatchObject({ code: VOB_TOKEN_INVALID });
    await expect(precheckVobSignup("tok", NOW, deps({ linkedElsewhere: async () => true }))).rejects.toMatchObject({ code: VOB_TOKEN_INVALID });
    await expect(precheckVobSignup("tok", NOW, deps({ read: async () => null }))).rejects.toMatchObject({ code: VOB_TOKEN_INVALID });
  });

  it("is disabled when the configuration is missing", async () => {
    await expect(precheckVobSignup("tok", NOW, deps({ loadConfig: async () => null }))).rejects.toMatchObject({ code: VOB_TOKEN_INVALID });
  });

  function recordingTx(updateError?: unknown) {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = {
      update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { if (updateError) throw updateError; updates.push({ table, values }); } }) }),
      insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return Object.assign(Promise.resolve(), { onConflictDoNothing: async () => undefined });
      } }),
    };
    return { tx: tx as never, updates, inserts };
  }
  const plan = { tokenId: "t1", discordUserId: DISCORD, discordUsername: "neko", organizationId: ORG, guildJoinedAt: null, requiresApproval: false };

  it("activates the account, links Discord, joins V.O.B and records the automatic approval", async () => {
    const rec = recordingTx();
    await applyVobSignup(rec.tx, USER, plan, NOW);
    expect(rec.updates[0].values).toMatchObject({ discordId: DISCORD, registrationOrigin: "discord_vob", registrationPlaceId: ORG, accessStatus: "active" });
    expect(rec.inserts.find((i) => i.table === schema.organizationMembers)?.values).toMatchObject({ organizationId: ORG, userId: USER, role: "member" });
    expect(rec.inserts.find((i) => i.table === schema.accessDecisions)?.values).toMatchObject({ actorUserId: null, reasonCode: VOB_REGISTRATION_REASON });
  });

  it("rejects a second consumption and a Discord ID linked concurrently", async () => {
    store.consumed = false;
    await expect(applyVobSignup(recordingTx().tx, USER, plan, NOW)).rejects.toMatchObject({ code: VOB_TOKEN_INVALID });
    store.consumed = true;
    await expect(applyVobSignup(recordingTx({ code: "23505" }).tx, USER, plan, NOW)).rejects.toMatchObject({ code: VOB_TOKEN_INVALID });
  });
});

describe("sharing with GLab and admin review", () => {
  it("shares only display name, affiliation and Discord name", () => {
    expect(toSharedMember({ userId: USER, displayName: "ねこ", discordUsername: "neko" })).toEqual({ userId: USER, displayName: "ねこ", affiliation: "V.O.B", discordUsername: "neko" });
  });

  it("shows discord_vob as an automatic approval with the Discord ID, not an exception", () => {
    expect(accessReviewOrigin("discord_vob")).toEqual({ registrationOrigin: "discord_vob", exception: false, defaultDecision: null });
    const label = registrationOriginLabel({ registrationOrigin: "discord_vob", exception: false, vob: { discordUserId: DISCORD, guildJoinedAt: null } });
    expect(label).toContain("V.O.B (Discord)");
    expect(label).toContain(DISCORD);
  });

  it("reads only well-formed tokens from the registration link", () => {
    expect(readLinkToken(`?vob=${FAKE_LINK_VALUE}`)).toBe(FAKE_LINK_VALUE);
    expect(readLinkToken("?vob=short")).toBeNull();
    expect(readLinkToken("?vob=bad%20token%20with%20spaces%20xxxx")).toBeNull();
    expect(readLinkToken("")).toBeNull();
  });
});

describe("081_vob_discord_registration", () => {
  const body = readFileSync(new URL("../../../migrations/081_vob_discord_registration.sql", import.meta.url), "utf8").replace(/--[^\n]*\n/g, "");
  it("stores only token hashes and extends the origin vocabulary", () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS vob_registration_tokens/);
    expect(body).toMatch(/token_hash TEXT NOT NULL UNIQUE/);
    expect(body).not.toMatch(/\btoken TEXT/);
    expect(body).toMatch(/registration_origin IN \('venue', 'outside_venue', 'discord_vob'\)/);
  });
  it("never drops or retypes tables or columns", () => {
    expect(body).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(body).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
  });
});
