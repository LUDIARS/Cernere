/**
 * V.O.B 登録トークンの状態判定 (純粋関数、副作用なし)。
 *   期限内・未消費・未失効 → usable (発行時の requiresApproval をそのまま運ぶ)
 *   それ以外 (未知・消費済み・失効・期限切れ) → invalid (422 vob_token_invalid)
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

export interface VobTokenRow {
  id: string;
  discordUserId: string;
  discordUsername: string | null;
  organizationId: string;
  guildJoinedAt: Date | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  requiresApproval: boolean;
}

export type VobTokenOutcome =
  | { kind: "usable"; tokenId: string; discordUserId: string; discordUsername: string | null; organizationId: string; guildJoinedAt: Date | null; requiresApproval: boolean }
  | { kind: "invalid" };

export function vobTokenOutcome(row: VobTokenRow | null, now: Date): VobTokenOutcome {
  if (!row || row.consumedAt || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return { kind: "invalid" };
  return {
    kind: "usable",
    tokenId: row.id,
    discordUserId: row.discordUserId,
    discordUsername: row.discordUsername,
    organizationId: row.organizationId,
    guildJoinedAt: row.guildJoinedAt,
    requiresApproval: row.requiresApproval,
  };
}
