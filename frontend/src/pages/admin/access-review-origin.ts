/**
 * 利用許可の審査画面での登録経路の見せ方 (spec/feature/venue-network-registration.md §7)。
 * 会場外からの登録は「例外」と表示し、拒否を既定 (先頭・強調) の操作にする。
 */

import type { AccessDecision, AccessReviewItem } from "../../lib/user-access-api";

interface ReviewAction { decision: AccessDecision; label: string; reason: string }

type OriginView = Pick<AccessReviewItem, "registrationOrigin" | "exception"> & Partial<Pick<AccessReviewItem, "vob">>;

export function registrationOriginLabel(item: OriginView): string | null {
  if (item.exception || item.registrationOrigin === "outside_venue") return "会場外からの登録 (例外)";
  if (item.registrationOrigin === "venue") return "会場で登録 (自動許可)";
  if (item.registrationOrigin === "discord_vob") {
    const joined = item.vob?.guildJoinedAt ? ` / サーバー参加 ${new Date(item.vob.guildJoinedAt).toLocaleString()}` : "";
    return `V.O.B (Discord) から登録 (自動許可)${item.vob ? ` / Discord ID ${item.vob.discordUserId}` : ""}${joined}`;
  }
  return null;
}

/** 既定の操作を先頭にして強調する。既定がなければ従来どおり許可・解除を強調する。 */
export function orderedReviewActions(item: Pick<AccessReviewItem, "defaultDecision">, actions: readonly ReviewAction[]):
  Array<{ action: ReviewAction; primary: boolean }> {
  const preferred = item.defaultDecision;
  const hasPreferred = preferred !== null && actions.some((a) => a.decision === preferred);
  const ordered = hasPreferred
    ? [...actions.filter((a) => a.decision === preferred), ...actions.filter((a) => a.decision !== preferred)]
    : [...actions];
  return ordered.map((action) => ({
    action,
    primary: hasPreferred ? action.decision === preferred : action.decision === "approve" || action.decision === "unlock",
  }));
}
