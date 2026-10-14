/**
 * Discord Bot の DM でログイン通知を送る (SPEC-LOGIN-ALERT)。
 *
 * Cr 専用 Bot (CERNERE_DISCORD_ALERT_BOT_TOKEN) で `POST /users/@me/channels` → `POST /channels/{id}/messages`。
 * 連携済みでも DM が届くとは限らない (共通サーバー無し・DM 無効・ブロック)。その場合は
 * 恒久失敗として返し、宛先を degraded にする。429 は Retry-After に従って再試行させる。
 * mention を実発火させないよう allowed_mentions は空にし、可変部分は呼び出し側で escapeDiscord する。
 */

import { config } from "../config.js";

const API = "https://discord.com/api/v10";
const MAX_CONTENT = 1900;

export class AlertDeliveryError extends Error {
  constructor(message: string, readonly permanent: boolean, readonly retryAfterMs?: number) {
    super(message);
    this.name = "AlertDeliveryError";
  }
}

/** 本文中のマークダウンと mention 記号を無害化する (UA や表示名は送信者が偽れる)。 */
export function escapeDiscord(text: string): string {
  return text.replace(/[\\*_`~|>@#:<]/g, (c) => `\\${c}`);
}

async function call(path: string, body: unknown, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${API}${path}`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bot ${config.discordAlertBotToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? "5");
    throw new AlertDeliveryError("Discord rate limited", false, Math.max(1, retry) * 1000);
  }
  if (res.status === 403 || res.status === 404) {
    // 50007: Cannot send messages to this user (DM 不可)。宛先側の設定なので再試行しない。
    throw new AlertDeliveryError("Discord cannot deliver a DM to this user", true);
  }
  if (!res.ok) throw new AlertDeliveryError(`Discord API ${res.status}`, res.status >= 400 && res.status < 500);
  return await res.json() as Record<string, unknown>;
}

export async function sendDiscordDm(discordUserId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!config.discordAlertBotToken) throw new AlertDeliveryError("Discord notifications are not configured", true);
  const channel = await call("/users/@me/channels", { recipient_id: discordUserId }, fetchImpl);
  if (typeof channel.id !== "string") throw new AlertDeliveryError("Discord did not open a DM channel", false);
  await call(`/channels/${channel.id}/messages`, {
    // 可変部分は文面を組み立てるときに escapeDiscord 済み。固定文の URL は自動リンクのまま残す。
    content: text.slice(0, MAX_CONTENT),
    allowed_mentions: { parse: [] },
  }, fetchImpl);
}
