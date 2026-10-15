/** 同意画面の文言 (権限キー・公開範囲 → 利用者向けの表示)。 */

import type { ConsentAudienceView, ConsentPermissionView } from "../../lib/consent-api";

const PROFILE_LABELS: Record<string, string> = {
  login: "ユーザー名",
  displayName: "表示名",
  email: "メールアドレス",
  avatarUrl: "アイコン",
  role: "Cernere のロール",
  bio: "自己紹介",
  roleTitle: "役割",
  expertise: "得意分野",
  hobbies: "趣味",
};

const CLAIM_LABELS: Record<string, string> = {
  discord_id: "Discord の ID",
  discord_username: "Discord のユーザー名",
};

const OIDC_LABELS: Record<string, string> = {
  email: "メールアドレス",
  profile: "プロフィール (表示名・ユーザー名・アイコン)",
};

export function permissionLabel(permission: Pick<ConsentPermissionView, "key">): string {
  const key = permission.key;
  if (key === "identity.basic") return "基本的な ID (あなたを識別する固有 ID)";
  const dot = key.indexOf(".");
  const prefix = key.slice(0, dot);
  const name = key.slice(dot + 1);
  switch (prefix) {
    case "profile": return `プロフィール: ${PROFILE_LABELS[name] ?? name}`;
    case "identity_claim": return CLAIM_LABELS[name] ?? name;
    case "user_data": return `サービスに預けるデータ: ${name.replace(/^module:/, "")}`;
    case "oidc": return OIDC_LABELS[name] ?? name;
    default: return key;
  }
}

export function audienceLabel(view: ConsentAudienceView): string {
  switch (view.audience) {
    case "self": return "あなただけ";
    case "service_users": return "このサービスの他の利用者";
    case "public": return "誰でも (ログインしていない人を含む)";
    case "other_services": return `他のサービス: ${(view.services ?? []).join("、")}`;
  }
}

/** 出所の注記。サービスの申告は Cernere が検証できないことを明示する。 */
export function audienceSource(view: ConsentAudienceView): string {
  return view.source === "cernere" ? "Cernere が共有" : "サービスの申告";
}
