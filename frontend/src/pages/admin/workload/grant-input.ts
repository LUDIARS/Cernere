/**
 * Builds non-monitor workload grants from fixed choices.
 * Mirrors server/src/workload/input.ts and Excubitor GrantSchema; the server re-validates.
 * @implements SPEC-WORKLOAD-AUTHORITY
 */

export const OPERATION_VERBS = [
  "update", "restart", "deploy", "reflect", "start", "stop", "bootstrap", "data-export", "data-import",
] as const;
export type OperationVerb = typeof OPERATION_VERBS[number];
export type GrantKind = "operation" | "hq-config" | "vault" | "bundle";

export const WORKLOAD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const SERVICE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_VAULT_KEYS = 500;
const MAX_KEY_LENGTH = 128;
const MAX_RESOURCE_LENGTH = 256;

export interface GrantFormValues {
  kind: GrantKind;
  subject: string;
  audience: string;
  verb: OperationVerb;
  code: string;
  repository: string;
  keys: string;
}

export interface GrantPayload {
  subject: string;
  audience: string;
  action: string;
  resource: string;
  keys?: string[];
}

export type GrantBuildResult = { ok: true; payload: GrantPayload } | { ok: false; error: string };

/** @implements SPEC-WORKLOAD-AUTHORITY — one key per line, exact names, no duplicates. */
export function parseVaultKeys(text: string): { ok: true; keys: string[] } | { ok: false; error: string } {
  // Blank lines (e.g. a trailing newline) are ignored; any other whitespace is rejected.
  const lines = text.split("\n").map(line => line.replace(/\r$/, "")).filter(line => line.length > 0);
  if (lines.length === 0) return { ok: false, error: "取得を許可する秘密情報の名前を 1 行に 1 つ入力してください。" };
  if (lines.length > MAX_VAULT_KEYS) return { ok: false, error: `秘密情報の名前は ${MAX_VAULT_KEYS} 個までです。` };
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length > MAX_KEY_LENGTH || !KEY_NAME.test(line)) {
      return { ok: false, error: `秘密情報の名前「${line}」は使えません。英字か _ で始まる英数字と _ だけにしてください（ワイルドカード・空白は不可）。` };
    }
    if (seen.has(line)) return { ok: false, error: `秘密情報の名前「${line}」が重複しています。` };
    seen.add(line);
  }
  return { ok: true, keys: lines };
}

/** @implements SPEC-WORKLOAD-AUTHORITY — resource prefix is fixed per action, never typed. */
function resourceFor(values: GrantFormValues): { ok: true; action: string; resource: string } | { ok: false; error: string } {
  switch (values.kind) {
    case "hq-config":
      return { ok: true, action: "hq-config", resource: "service:concordia" };
    case "bundle":
      if (!REPOSITORY.test(values.repository)) {
        return { ok: false, error: "リポジトリは owner/name の形で入力してください（ワイルドカード・空白・追加の区切りは不可）。" };
      }
      return { ok: true, action: "bundle", resource: `repository:${values.repository}` };
    case "operation":
    case "vault": {
      if (!SERVICE_CODE.test(values.code)) {
        return { ok: false, error: "サービスコードは英数字で始まる英数字と . _ - だけにしてください（ワイルドカード・空白・: / は不可）。" };
      }
      if (values.kind === "operation" && !OPERATION_VERBS.includes(values.verb)) {
        return { ok: false, error: "操作を一覧から選んでください。" };
      }
      return { ok: true, action: values.kind === "vault" ? "vault" : `operation:${values.verb}`, resource: `service:${values.code}` };
    }
    default:
      return { ok: false, error: "許可の種類を一覧から選んでください。" };
  }
}

/** @implements SPEC-WORKLOAD-AUTHORITY — explicit subject/audience; keys only for vault. */
export function buildGrantPayload(values: GrantFormValues): GrantBuildResult {
  if (!WORKLOAD_ID_PATTERN.test(values.subject) || values.subject.length > 128
    || !WORKLOAD_ID_PATTERN.test(values.audience) || values.audience.length > 128) {
    return { ok: false, error: "拠点 ID は site/workload の形（小文字英数字と . _ -）で入力してください。" };
  }
  const target = resourceFor(values);
  if (!target.ok) return target;
  if (target.resource.length > MAX_RESOURCE_LENGTH) return { ok: false, error: "対象の名前が長すぎます。" };
  const payload: GrantPayload = { subject: values.subject, audience: values.audience, action: target.action, resource: target.resource };
  if (values.kind !== "vault") return { ok: true, payload };
  const keys = parseVaultKeys(values.keys);
  if (!keys.ok) return keys;
  return { ok: true, payload: { ...payload, keys: keys.keys } };
}

/** @implements SPEC-WORKLOAD-AUTHORITY — human-readable confirmation of the exact grant. */
export function describeGrant(payload: GrantPayload): string {
  const keys = payload.keys ? `\n取得を許可する秘密情報: ${payload.keys.join(", ")}` : "";
  return `${payload.subject} に ${payload.audience} での「${payload.action}」（対象 ${payload.resource}）を許可します。${keys}\n逆方向や他の操作は別の許可が必要です。続けますか？`;
}
