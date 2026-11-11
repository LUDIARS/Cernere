/**
 * SPEC-VOB-DISCORD-REGISTRATION: Cernere の Discord Bot の設定 (DB + 管理画面)、
 * サーバー参加から日が浅い人の許可制、管理者チャンネルへの通知。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/vob/vob-token-store.js", () => ({
  readVobToken: async () => null,
  consumeVobToken: async () => true,
}));
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
// action-auth の resolveBrowserActionTarget だけを使う。ブラウザの WebAuthn 実装は読まない。
vi.mock("../../../frontend/src/lib/webauthn", () => ({ startAuthentication: vi.fn() }));
vi.mock("../../../frontend/src/lib/browser-token-store", () => ({ getAccessToken: () => null }));
vi.mock("../../../frontend/src/lib/browser-refresh", () => ({ refreshBrowserAccessToken: vi.fn() }));

const schema = await import("../../src/db/schema.js");
const { parseVobConfig } = await import("../../src/vob/vob-config.js");
const { requiresAdminApproval } = await import("../../src/vob/approval-window.js");
const { formatAdminNotice, postAdminNotice, sanitizeForNotice, sendAdminNoticeInBackground } = await import("../../src/vob/discord-admin-notice.js");
const { handleVobInteraction, VOB_MESSAGES, VOB_NEEDS_APPROVAL_NOTE } = await import("../../src/vob/vob-interactions.js");
const { applyVobSignup } = await import("../../src/vob/vob-registration-signup.js");
const { joinVobOrganizationOnApproval } = await import("../../src/vob/vob-organization-membership.js");
const { resolveWsActionTarget, protectedActionSchema } = await import("../../src/auth/action-policy.js");
const { resolveBrowserActionTarget } = await import("../../../frontend/src/lib/action-auth");
const { discordBotSettingsCommand } = await import("../../src/vob/discord-bot-settings-command.js");
const { settingsWriteValues, toSettingsView } = await import("../../src/vob/discord-bot-settings-store.js");
const { registrationOriginLabel } = await import("../../../frontend/src/pages/admin/access-review-origin");

const NOW = new Date("2026-11-11T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "55555555-5555-4555-8555-555555555555";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const GUILD = "123456789012345678";
const DISCORD = "987654321098765432";
const CHANNEL = "222222222222222222";
const APP = "111111111111111111";
const PUBLIC_HEX = "ab".repeat(32);
const WORD_JOINER = String.fromCharCode(0x2060);
/** 本物の値に見えない、テスト用の固定値 */
const FAKE_BOT_VALUE = "fake-bot-value";
const FAKE_LINK_VALUE = "x".repeat(32);

const INPUT = {
  enabled: true, applicationId: APP, publicKeyHex: PUBLIC_HEX, botToken: FAKE_BOT_VALUE, guildId: GUILD,
  organizationId: ORG, adminChannelId: CHANNEL, approvalWindowDays: 7,
};

describe("parseVobConfig", () => {
  it("returns the config only when enabled and every required value is well-formed", () => {
    expect(parseVobConfig(INPUT, "https://cr.example/")).toMatchObject({
      applicationId: APP, adminChannelId: CHANNEL, approvalWindowDays: 7, frontendUrl: "https://cr.example",
    });
    expect(parseVobConfig({ ...INPUT, enabled: false }, "x")).toBeNull();
  });

  it("treats missing values as disabled", () => {
    for (const key of ["applicationId", "publicKeyHex", "botToken", "guildId", "organizationId"] as const) {
      expect(parseVobConfig({ ...INPUT, [key]: null }, "x"), key).toBeNull();
    }
    expect(parseVobConfig({ ...INPUT, approvalWindowDays: null }, "x")).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(parseVobConfig({ ...INPUT, applicationId: "app" }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, guildId: "12" }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, publicKeyHex: "zz".repeat(32) }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, organizationId: "vob" }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, adminChannelId: "general" }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, approvalWindowDays: 91 }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, approvalWindowDays: -1 }, "x")).toBeNull();
    expect(parseVobConfig({ ...INPUT, approvalWindowDays: 1.5 }, "x")).toBeNull();
  });

  it("allows running without an admin channel", () => {
    expect(parseVobConfig({ ...INPUT, adminChannelId: null }, "x")?.adminChannelId).toBeNull();
    expect(parseVobConfig({ ...INPUT, adminChannelId: "  " }, "x")?.adminChannelId).toBeNull();
  });
});

describe("requiresAdminApproval", () => {
  it("requires approval strictly within the window", () => {
    expect(requiresAdminApproval(new Date(NOW.getTime() - 7 * DAY + 1), NOW, 7)).toBe(true);
    expect(requiresAdminApproval(new Date(NOW.getTime() - 7 * DAY), NOW, 7)).toBe(false);
    expect(requiresAdminApproval(new Date(NOW.getTime() - 30 * DAY), NOW, 7)).toBe(false);
  });

  it("treats an unknown join date as recent", () => {
    expect(requiresAdminApproval(null, NOW, 7)).toBe(true);
  });

  it("never requires approval when the window is 0 days", () => {
    expect(requiresAdminApproval(null, NOW, 0)).toBe(false);
    expect(requiresAdminApproval(NOW, NOW, 0)).toBe(false);
  });
});

describe("admin channel notice", () => {
  it("neutralises mentions, markdown and line breaks in other people's names", () => {
    const name = sanitizeForNotice("@everyone <@123456> **bold**\nfake line");
    expect(name).not.toContain("@everyone");
    expect(name).toContain(`@${WORD_JOINER}everyone`);
    expect(name).not.toMatch(/(^|[^\\])<@/);
    expect(name).not.toContain("\n");
    expect(name).toContain("\\*\\*bold\\*\\*");
    expect(sanitizeForNotice("a".repeat(200)).length).toBeLessThanOrEqual(65);
  });

  it("states who, when they joined, the result and the link expiry", () => {
    const text = formatAdminNotice({
      result: "issued_needs_approval", discordUserId: DISCORD, discordUsername: "@here",
      guildJoinedAt: new Date(NOW.getTime() - DAY), tokenExpiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });
    expect(text).toContain(DISCORD);
    expect(text).toContain("2026-11-10T03:00:00.000Z");
    expect(text).toContain("管理者の許可");
    expect(text).toContain("2026-11-11T03:30:00.000Z");
    expect(text).not.toContain("@here");
    expect(formatAdminNotice({ result: "not_member", discordUserId: DISCORD, discordUsername: null, guildJoinedAt: null, tokenExpiresAt: null }))
      .toContain("サーバー参加: 不明");
  });

  it("posts to the channel with every mention disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await postAdminNotice(FAKE_BOT_VALUE, CHANNEL, "hi", fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({ content: "hi", allowed_mentions: { parse: [] } });
    await expect(postAdminNotice(FAKE_BOT_VALUE, CHANNEL, "hi", (async () => new Response("", { status: 403 })) as never)).rejects.toThrow(/403/);
  });

  it("does not send when no admin channel is configured, and reports failures without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    sendAdminNoticeInBackground({ botToken: FAKE_BOT_VALUE, adminChannelId: null },
      { result: "issued", discordUserId: DISCORD, discordUsername: null, guildJoinedAt: null, tokenExpiresAt: null }, () => undefined, fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    const onError = vi.fn();
    sendAdminNoticeInBackground({ botToken: FAKE_BOT_VALUE, adminChannelId: CHANNEL },
      { result: "issued", discordUserId: DISCORD, discordUsername: null, guildJoinedAt: null, tokenExpiresAt: null }, onError, fetchImpl as never);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });
});

describe("/register with the approval window and admin notices", () => {
  const config = parseVobConfig(INPUT, "https://cr.example")!;
  const command = { type: 2, guild_id: GUILD, data: { name: "register" }, member: { user: { id: DISCORD, username: "neko" } } };
  const deps = (joinedAt: Date | null, over: Partial<Parameters<typeof handleVobInteraction>[1]> = {}) => ({
    config,
    now: () => NOW,
    isDiscordLinked: vi.fn(async () => false),
    fetchGuildMember: vi.fn(async () => ({ discordUserId: DISCORD, username: "neko", joinedAt })),
    issueToken: vi.fn(async () => ({ token: FAKE_LINK_VALUE, expiresAt: new Date(NOW.getTime() + 30 * 60_000) })),
    notifyAdmins: vi.fn(),
    ...over,
  });

  it("issues an approval-required token to someone who joined within 7 days and tells the admins", async () => {
    const d = deps(new Date(NOW.getTime() - DAY));
    const reply = await handleVobInteraction(command, d);
    expect(d.issueToken).toHaveBeenCalledWith(expect.objectContaining({ requiresApproval: true }));
    expect(reply.data?.content).toContain(VOB_NEEDS_APPROVAL_NOTE);
    expect(d.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ result: "issued_needs_approval", discordUserId: DISCORD }));
  });

  it("issues a normal token to a long-standing member and still tells the admins", async () => {
    const d = deps(new Date(NOW.getTime() - 30 * DAY));
    const reply = await handleVobInteraction(command, d);
    expect(d.issueToken).toHaveBeenCalledWith(expect.objectContaining({ requiresApproval: false }));
    expect(reply.data?.content).not.toContain(VOB_NEEDS_APPROVAL_NOTE);
    expect(d.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ result: "issued" }));
  });

  it("tells the admins about non-members and already-linked accounts too", async () => {
    const outsider = deps(null, { fetchGuildMember: vi.fn(async () => null) });
    expect((await handleVobInteraction(command, outsider)).data?.content).toBe(VOB_MESSAGES.notMember);
    expect(outsider.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ result: "not_member" }));
    const linked = deps(null, { isDiscordLinked: vi.fn(async () => true) });
    expect((await handleVobInteraction(command, linked)).data?.content).toBe(VOB_MESSAGES.alreadyLinked);
    expect(linked.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ result: "already_linked" }));
  });

  it("does not notify for other servers, and a failing notifier does not break the reply", async () => {
    const d = deps(null);
    await handleVobInteraction({ ...command, guild_id: "1" }, d);
    expect(d.notifyAdmins).not.toHaveBeenCalled();
    const broken = deps(new Date(NOW.getTime() - 30 * DAY), { notifyAdmins: vi.fn(() => { throw new Error("down"); }) });
    expect((await handleVobInteraction(command, broken)).data?.content).toContain(FAKE_LINK_VALUE);
  });
});

function recordingTx() {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push({ table, values }); } }) }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return Object.assign(Promise.resolve(), { onConflictDoNothing: async () => undefined });
    } }),
  };
  return { tx: tx as never, updates, inserts };
}

describe("signup and approval for approval-required tokens", () => {
  const plan = { tokenId: "t1", discordUserId: DISCORD, discordUsername: "neko", organizationId: ORG, guildJoinedAt: null, requiresApproval: true };

  it("keeps the account pending, links Discord, and neither joins V.O.B nor records an automatic approval", async () => {
    const rec = recordingTx();
    expect(await applyVobSignup(rec.tx, USER, plan, NOW)).toEqual({ organizationId: ORG, pending: true });
    expect(rec.updates[0].values).toMatchObject({ discordId: DISCORD, registrationOrigin: "discord_vob", registrationPlaceId: ORG });
    expect(rec.updates[0].values).not.toHaveProperty("accessStatus");
    expect(rec.inserts.find((i) => i.table === schema.organizationMembers)).toBeUndefined();
    expect(rec.inserts.find((i) => i.table === schema.accessDecisions)).toBeUndefined();
  });

  it("joins the V.O.B organization when an admin approves a discord_vob account", async () => {
    const rec = recordingTx();
    expect(await joinVobOrganizationOnApproval(rec.tx, { id: USER, registrationOrigin: "discord_vob", registrationPlaceId: ORG }, NOW)).toBe(true);
    expect(rec.inserts[0]).toMatchObject({ table: schema.organizationMembers, values: { organizationId: ORG, userId: USER, role: "member" } });
  });

  it("does nothing for other origins or without an organization", async () => {
    const rec = recordingTx();
    expect(await joinVobOrganizationOnApproval(rec.tx, { id: USER, registrationOrigin: "venue", registrationPlaceId: ORG }, NOW)).toBe(false);
    expect(await joinVobOrganizationOnApproval(rec.tx, { id: USER, registrationOrigin: "discord_vob", registrationPlaceId: null }, NOW)).toBe(false);
    expect(rec.inserts).toHaveLength(0);
  });

  it("labels approval-required registrations separately in the review screen", () => {
    const pending = registrationOriginLabel({ registrationOrigin: "discord_vob", exception: false,
      vob: { discordUserId: DISCORD, guildJoinedAt: null, requiresApproval: true, approvalWindowDays: 7 } });
    expect(pending).toContain("サーバー参加 7 日以内のため許可待ち");
    const automatic = registrationOriginLabel({ registrationOrigin: "discord_vob", exception: false,
      vob: { discordUserId: DISCORD, guildJoinedAt: null, requiresApproval: false, approvalWindowDays: 7 } });
    expect(automatic).toContain("(自動許可)");
  });
});

describe("discord_bot.update action proof", () => {
  it("is a protected WS action bound to the fixed settings resource on both sides", () => {
    expect(protectedActionSchema.safeParse("discord_bot.update").success).toBe(true);
    expect(resolveWsActionTarget(ADMIN, "discord_bot", "update", { enabled: false })).toEqual({ action: "discord_bot.update", resource: "settings" });
    expect(resolveBrowserActionTarget("discord_bot", "update", { enabled: false }, ADMIN)).toEqual({ action: "discord_bot.update", resource: "settings" });
  });

  it("does not step up reading or command registration", () => {
    expect(resolveWsActionTarget(ADMIN, "discord_bot", "get", {})).toBeNull();
    expect(resolveWsActionTarget(ADMIN, "discord_bot", "register_commands", {})).toBeNull();
  });
});

describe("discord_bot settings command", () => {
  const stored = { ...INPUT, enabled: false, hasBotToken: true, botTokenUnreadable: false, updatedAt: null };
  const view = toSettingsView(stored, "https://api.cr.example/", "https://cr.example");
  const deps = (over = {}) => ({
    requireAdmin: vi.fn(async () => undefined),
    load: vi.fn(async () => stored),
    view: vi.fn(async () => view),
    save: vi.fn(async () => view),
    registerCommands: vi.fn(async () => ["register"]),
    ...over,
  });
  const update = { enabled: true, applicationId: APP, publicKeyHex: PUBLIC_HEX, guildId: GUILD, organizationId: ORG, adminChannelId: CHANNEL, approvalWindowDays: 7 };

  it("rejects non-admins before reading or writing anything", async () => {
    const d = deps({ requireAdmin: vi.fn(async () => { throw Object.assign(new Error("System admin required"), { statusCode: 403 }); }) });
    await expect(discordBotSettingsCommand(USER, "update", update, d)).rejects.toThrow("System admin required");
    await expect(discordBotSettingsCommand(USER, "get", {}, d)).rejects.toThrow("System admin required");
    expect(d.save).not.toHaveBeenCalled();
    expect(d.view).not.toHaveBeenCalled();
  });

  it("keeps the stored bot token when the token is omitted", async () => {
    const d = deps();
    await discordBotSettingsCommand(ADMIN, "update", update, d);
    await discordBotSettingsCommand(ADMIN, "update", { ...update, botToken: "  " }, d);
    for (const [actor, saved] of d.save.mock.calls as unknown as Array<[string, Record<string, unknown>]>) {
      expect(actor).toBe(ADMIN);
      expect(saved.enabled).toBe(true);
      expect(saved.botToken).toBeUndefined();
    }
    expect(d.save).toHaveBeenCalledTimes(2);
  });

  it("validates strictly and refuses to enable an incomplete configuration", async () => {
    const d = deps({ load: vi.fn(async () => ({ ...stored, botToken: null, hasBotToken: false })) });
    await expect(discordBotSettingsCommand(ADMIN, "update", update, d)).rejects.toMatchObject({ statusCode: 400 });
    await expect(discordBotSettingsCommand(ADMIN, "update", { ...update, extra: 1 }, deps())).rejects.toMatchObject({ statusCode: 400 });
    await expect(discordBotSettingsCommand(ADMIN, "update", { ...update, guildId: "guild" }, deps())).rejects.toMatchObject({ statusCode: 400 });
    await expect(discordBotSettingsCommand(ADMIN, "update", { ...update, approvalWindowDays: 91 }, deps())).rejects.toMatchObject({ statusCode: 400 });
    // 無効のままなら欠けていても保存できる (途中まで入れておける)。
    const draft = deps();
    await discordBotSettingsCommand(ADMIN, "update", { ...update, enabled: false, applicationId: "", publicKeyHex: null }, draft);
    expect(draft.save).toHaveBeenCalledWith(ADMIN, expect.objectContaining({ applicationId: null, publicKeyHex: null }));
  });

  it("registers the slash commands with the stored settings only", async () => {
    const d = deps();
    expect(await discordBotSettingsCommand(ADMIN, "register_commands", {}, d)).toEqual({ registered: ["register"] });
    expect(d.registerCommands).toHaveBeenCalledWith({ applicationId: APP, guildId: GUILD, botToken: FAKE_BOT_VALUE });
    const missing = deps({ load: vi.fn(async () => ({ ...stored, botToken: null })) });
    await expect(discordBotSettingsCommand(ADMIN, "register_commands", {}, missing)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("never returns the bot token and shows the interactions endpoint on the Cernere server", () => {
    expect(JSON.stringify(view)).not.toContain(FAKE_BOT_VALUE);
    expect(view).toMatchObject({ hasBotToken: true, ready: false, interactionsEndpointUrl: "https://api.cr.example/api/discord/vob/interactions" });
    expect(toSettingsView({ ...stored, enabled: true }, "https://api.cr.example", "x").ready).toBe(true);
  });

  it("writes the encrypted token only when a new one is given", () => {
    const kept = settingsWriteValues({ ...update }, ADMIN, NOW, () => "enc");
    expect(kept.set).not.toHaveProperty("botTokenEnc");
    expect(kept.insert.botTokenEnc).toBeNull();
    const replaced = settingsWriteValues({ ...update, botToken: FAKE_BOT_VALUE }, ADMIN, NOW, (plain) => `enc(${plain.length})`);
    expect(replaced.set.botTokenEnc).toBe(`enc(${FAKE_BOT_VALUE.length})`);
    expect(replaced.insert).toMatchObject({ id: 1, updatedByUserId: ADMIN });
  });
});

describe("083_discord_bot_settings", () => {
  const body = readFileSync(new URL("../../../migrations/083_discord_bot_settings.sql", import.meta.url), "utf8").replace(/--[^\n]*\n/g, "");
  it("keeps a single settings row, an encrypted token column and the approval flag", () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS discord_bot_settings/);
    expect(body).toMatch(/CHECK \(id = 1\)/);
    expect(body).toMatch(/bot_token_enc TEXT/);
    expect(body).not.toMatch(/\bbot_token TEXT/);
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false/);
    expect(body).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
