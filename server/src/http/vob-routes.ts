/**
 * V.O.B の HTTP transport (spec/feature/vob-discord-registration.md §5)。
 *   POST /api/discord/vob/interactions  Discord interaction (Ed25519 署名必須)
 *   GET  /api/vob/shared-members        GLab 向けの一部共有 (project token + vob-roster:read)
 * 機能が無効 (設定が欠けている) なら 503。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import type uWS from "uWebSockets.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { verifyDiscordSignature } from "../vob/discord-signature.js";
import { fetchGuildMember } from "../vob/discord-guild.js";
import { readVobConfig, type VobConfig } from "../vob/vob-config.js";
import { handleVobInteraction, type VobInteractionDeps } from "../vob/vob-interactions.js";
import { listVobSharedMembers } from "../vob/vob-shared-members.js";
import { issueVobToken } from "../vob/vob-token-store.js";
import { EXPORT_SCOPES, requireExportAuth } from "./export-auth.js";

interface HttpHelpers {
  readBody(res: uWS.HttpResponse, maxBytes: number, onAborted: () => void): Promise<string>;
  jsonResponse(res: uWS.HttpResponse, status: string, data: unknown, cookies: string[], headers: Readonly<Record<string, string>>): void;
  classifyError(error: unknown): { status: string; message: string };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function vobInteractionDeps(config: VobConfig): VobInteractionDeps {
  return {
    config,
    async isDiscordLinked(discordUserId) {
      const rows = await db.select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.discordId, discordUserId)).limit(1);
      return rows.length > 0;
    },
    fetchGuildMember: (discordUserId) => fetchGuildMember(config.botToken, config.guildId, discordUserId),
    issueToken: (input) => issueVobToken(input),
  };
}

export function registerVobRoutes(app: uWS.TemplatedApp, http: HttpHelpers): void {
  app.post("/api/discord/vob/interactions", async (res, req) => {
    const signature = req.getHeader("x-signature-ed25519");
    const timestamp = req.getHeader("x-signature-timestamp");
    let aborted = false;
    try {
      const raw = await http.readBody(res, 16_384, () => { aborted = true; });
      if (aborted) return;
      const config = readVobConfig();
      if (!config) throw AppError.withCode(503, "vob_disabled", "V.O.B registration is not configured");
      if (!verifyDiscordSignature({ publicKeyHex: config.publicKeyHex, signatureHex: signature, timestamp, rawBody: raw })) {
        throw AppError.unauthorized("invalid request signature");
      }
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw AppError.badRequest("Invalid JSON"); }
      const reply = await handleVobInteraction(body, vobInteractionDeps(config));
      if (!aborted) http.jsonResponse(res, "200 OK", reply, [], NO_STORE);
    } catch (error) {
      if (aborted) return;
      const failure = http.classifyError(error);
      http.jsonResponse(res, failure.status, { error: failure.message }, [], NO_STORE);
    }
  });

  app.get("/api/vob/shared-members", async (res, req) => {
    const authHeader = req.getHeader("authorization") ?? "";
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    try {
      await requireExportAuth(authHeader, EXPORT_SCOPES.vobRoster);
      const config = readVobConfig();
      if (!config) throw AppError.withCode(503, "vob_disabled", "V.O.B registration is not configured");
      const members = await listVobSharedMembers(config.organizationId);
      if (!aborted) http.jsonResponse(res, "200 OK", { members }, [], NO_STORE);
    } catch (error) {
      if (aborted) return;
      const failure = http.classifyError(error);
      http.jsonResponse(res, failure.status, { error: failure.message }, [], NO_STORE);
    }
  });
}
