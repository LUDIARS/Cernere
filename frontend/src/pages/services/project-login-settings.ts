/**
 * 管理画面のサービス詳細で、ログインの戻り先 (composite_origins) と PASETO の aud (hub_url) を編集する純関数。
 *
 * 規則はサーバの isCompositeOrigin (server/src/project/composite-origin-policy.ts) と同じにする:
 * path / query / fragment / 資格情報 / ワイルドカードの無い https のオリジン。ループバックは不可。
 * 最終判定はサーバ (assertCompositeRegistration) が行い、ここは保存前に分かる誤りを先に示すだけ。
 * 設計: spec/plan/2026-10-30-authcode-service-binding.md
 */

export interface LoginSettings {
  compositeOrigins: string[];
  hubUrl: string | null;
}

/** 本番に登録できる https のオリジンか。 */
export function isRegistrableOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.hostname.includes("*")) return false;
    const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost")
      || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return url.protocol === "https:" && !loopback;
  } catch {
    return false;
  }
}

/** 定義から今の設定を読む。 */
export function readLoginSettings(definition: Record<string, unknown> | null | undefined): LoginSettings {
  const origins = definition?.composite_origins;
  const hub = definition?.hub_url;
  return {
    compositeOrigins: Array.isArray(origins) ? origins.filter((o): o is string => typeof o === "string") : [],
    hubUrl: typeof hub === "string" ? hub : null,
  };
}

export type ParsedLoginSettings =
  | { ok: true; settings: LoginSettings }
  | { ok: false; errors: string[] };

/**
 * 入力欄の文字 (戻り先は 1 行に 1 つ) を設定にする。末尾の "/" は落とす (オリジンに揃える)。
 * hub_url は空なら未登録のまま (null)。
 */
export function parseLoginSettings(originsText: string, hubUrlText: string): ParsedLoginSettings {
  const errors: string[] = [];
  const origins: string[] = [];
  for (const line of originsText.split(/\r?\n/)) {
    const value = line.trim().replace(/\/+$/, "");
    if (!value) continue;
    if (!isRegistrableOrigin(value)) {
      errors.push(`戻り先 "${line.trim()}" は https のオリジン (例 https://example.com) にしてください`);
      continue;
    }
    if (!origins.includes(value)) origins.push(value);
  }
  if (origins.length > 100) errors.push("戻り先は 100 個までです");
  const hub = hubUrlText.trim().replace(/\/+$/, "");
  if (hub && !isRegistrableOrigin(hub)) errors.push(`hub_url "${hubUrlText.trim()}" は https のオリジンにしてください`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { compositeOrigins: origins, hubUrl: hub || null } };
}

/**
 * 保存する定義を作る。ほかの項目はそのまま残す。hub_url を空にした場合は、すでに登録済みなら
 * サーバ側で消せない (未指定は既存を残す) ため、既存の値を残す。
 */
export function withLoginSettings<T extends Record<string, unknown>>(definition: T, settings: LoginSettings): T {
  return {
    ...definition,
    composite_origins: settings.compositeOrigins,
    ...(settings.hubUrl ? { hub_url: settings.hubUrl } : {}),
  };
}

/**
 * Vault に入れる環境変数の名前 (server/src/project/vault-credentials.ts の projectCredentialNames と同じ規則)。
 */
export function credentialEnvNames(projectKey: string): { clientId: string; clientSecret: string } {
  const prefix = projectKey.toLowerCase() === "aedilis" ? "EXCUBITOR" : projectKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return { clientId: `${prefix}_CERNERE_CLIENT_ID`, clientSecret: `${prefix}_CERNERE_CLIENT_SECRET` };
}
