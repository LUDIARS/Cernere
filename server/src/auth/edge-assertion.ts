/**
 * エッジ認証 (Cloudflare Access バイパス) のアサーション検証と ID 解決
 *
 * spec/feature/edge-assertion-login.md §4 / §5。
 *
 * Hub から project WS 経由で渡された CF Access のアサーションを **Cernere 自身が**
 * 検証し、 対応する Cernere ユーザを解決して one-time authCode を発行する。
 * Hub の主張 (email や identity JSON) は一切信用しない。
 *
 * 検証は fail-closed。 どこかで判定できなくなったら通さない。
 */

import { createHash, randomUUID } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { checkRateLimit } from "../redis.js";
import { issueAuthCodeForUserId } from "./auth-code.js";
import { getEdgeSigningKey, type FetchLike } from "./edge-jwks.js";
import { fetchEdgeIdentity, type EdgeIdentity, type EdgeIdentityGroup } from "./edge-identity.js";
import { getActiveBinding, type EdgeIdpBinding } from "../project/edge-bindings.js";

/** アサーションの時刻ずれ許容幅。 */
const CLOCK_TOLERANCE_SEC = 60;
/** 同一 subject あたりのレート制限。 */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SEC = 5 * 60;

export type EdgeRejectReason =
  | "no_binding"
  | "malformed"
  | "signature"
  | "issuer"
  | "aud"
  | "expired"
  | "service_token"
  | "no_email"
  | "domain"
  | "device_check_required"
  | "role_mapping_unsupported"
  | "rate_limited"
  | "identity_mismatch"
  | "email_conflict"
  | "not_provisioned";

export class EdgeAssertionError extends Error {
  constructor(readonly reason: EdgeRejectReason, message?: string) {
    super(message ?? reason);
    this.name = "EdgeAssertionError";
  }
}

export interface EdgeAssertionParams {
  projectKey: string;
  assertion: string;
  /** Hub が転送した `CF_Authorization` クッキーの値 (get-identity 用)。 */
  cfAuthorization?: string;
  now?: number;
  fetchImpl?: FetchLike;
}

export interface EdgeAssertionResult {
  authCode: string;
  /** Hub 側の認可判断用。Cernere の system role には昇格させない。 */
  groups: EdgeIdentityGroup[];
  userId: string;
}

export interface AssertionClaims {
  email: string;
  cfSub: string | null;
  idpSubject: string | null;
  identityNonce: string | null;
  customName: string | null;
}

/**
 * アサーションの検証だけを行う純粋な経路 (DB / Redis に触らない)。
 *
 * 署名 / iss / aud / 期限 / サービストークン / email ドメインまでをここで見る。
 * ユーザ解決とプロビジョニングは呼び出し側 (authenticateEdgeAssertion) の担当。
 */
export async function verifyEdgeAssertion(
  binding: EdgeIdpBinding,
  assertion: string,
  options: { now?: number; fetchImpl?: FetchLike } = {},
): Promise<AssertionClaims> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = await verifyAssertion(binding, assertion, now, fetchImpl);
  const claims = extractClaims(binding, payload);
  assertEmailDomainAllowed(binding, claims.email);
  return claims;
}

export async function authenticateEdgeAssertion(
  params: EdgeAssertionParams,
): Promise<EdgeAssertionResult> {
  const now = params.now ?? Date.now();
  const fetchImpl = params.fetchImpl ?? fetch;

  const binding = await getActiveBinding(params.projectKey);
  if (!binding) throw new EdgeAssertionError("no_binding");
  // Device verification is not wired yet. A binding that explicitly requires
  // it must never silently receive the weaker default flow.
  if (binding.requireDeviceCheck) throw new EdgeAssertionError("device_check_required");
  // A safe global-role mapping needs persisted provenance so only an edge-
  // managed promotion can later be revoked. Until that exists, accepting
  // adminGroups would either leave sticky admins or demote manually assigned
  // admins. Reject the configuration instead of silently weakening either side.
  if (binding.adminGroups.length > 0) throw new EdgeAssertionError("role_mapping_unsupported");

  const claims = await verifyEdgeAssertion(binding, params.assertion, { now, fetchImpl });
  await enforceRateLimit(binding.projectKey, claims.idpSubject ?? claims.email);

  const identity = binding.fetchIdentity && params.cfAuthorization
    ? await fetchEdgeIdentity(binding.teamDomain, claims.identityNonce, params.cfAuthorization, fetchImpl)
    : null;

  // get-identity が別人の email を返したら、 どちらが正しいか判定できない。 通さない。
  if (identity?.email && normalizeEmail(identity.email) !== claims.email) {
    throw new EdgeAssertionError("identity_mismatch");
  }

  const userId = await resolveUser(binding, claims, identity);
  const groups = identity?.groups ?? [];
  // 他の認証経路 (password / passkey / oauth / guest) と同じく最終ログインを刻む。
  // ここを抜かすとエッジ経由のユーザだけ admin 画面で「未ログイン」に見える。
  await touchLastLogin(userId, new Date(now));

  // 解決したユーザが (競合削除等で) 消えていたら authCode は発行できない。
  const authCode = await issueAuthCodeForUserId(userId);
  if (!authCode) throw new EdgeAssertionError("not_provisioned");
  return { authCode, groups, userId };
}

// ── 1. アサーション検証 ──────────────────────────────────────

async function verifyAssertion(
  binding: EdgeIdpBinding,
  assertion: string,
  now: number,
  fetchImpl: FetchLike,
): Promise<JwtPayload> {
  if (typeof assertion !== "string" || assertion.trim() === "") {
    throw new EdgeAssertionError("malformed");
  }

  // kid を知るためのヘッダ読み取り。 検証はこの後 jwt.verify が行う
  // (どの鍵で検証するかを決めるためだけの decode で、 claim は一切信用しない)。
  const decoded = jwt.decode(assertion, { complete: true });
  const kid = decoded?.header?.kid;
  if (!decoded || typeof kid !== "string" || decoded.header.alg !== "RS256") {
    throw new EdgeAssertionError("malformed");
  }

  const key = await getEdgeSigningKey(binding.teamDomain, kid, now, fetchImpl);
  if (!key) throw new EdgeAssertionError("signature");

  let payload: JwtPayload;
  try {
    // aud は jsonwebtoken の option ではなく自前で照合する。 CF の aud は配列で、
    // 「登録済み AUD tag のいずれかを含むこと」 を完全一致で見たいため。
    const verified = jwt.verify(assertion, key, {
      algorithms: ["RS256"],
      issuer: `https://${binding.teamDomain}`,
      clockTolerance: CLOCK_TOLERANCE_SEC,
      clockTimestamp: Math.floor(now / 1000),
    });
    if (typeof verified === "string") throw new EdgeAssertionError("malformed");
    payload = verified;
  } catch (err) {
    if (err instanceof EdgeAssertionError) throw err;
    throw new EdgeAssertionError(mapVerifyError(err));
  }

  assertAudienceAllowed(binding, payload.aud);
  return payload;
}

/** `aud` は文字列または配列。 登録済み AUD tag を完全一致で含むことを要求する。 */
function assertAudienceAllowed(binding: EdgeIdpBinding, aud: unknown): void {
  const values = typeof aud === "string"
    ? [aud]
    : Array.isArray(aud) ? aud.filter((v): v is string => typeof v === "string") : [];
  const allowed = new Set(binding.audTags);
  if (!values.some((value) => allowed.has(value.trim().toLowerCase()))) {
    throw new EdgeAssertionError("aud");
  }
}

function mapVerifyError(err: unknown): EdgeRejectReason {
  const message = err instanceof Error ? err.message : "";
  if (err instanceof jwt.TokenExpiredError) return "expired";
  if (err instanceof jwt.NotBeforeError) return "expired";
  if (message.includes("audience")) return "aud";
  if (message.includes("issuer")) return "issuer";
  return "signature";
}

function extractClaims(binding: EdgeIdpBinding, payload: JwtPayload): AssertionClaims {
  // サービストークン (machine-to-machine) は人間ではないので通さない。
  const commonName = typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  const cfSub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (commonName !== "" || cfSub === "") throw new EdgeAssertionError("service_token");

  const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : "";
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@") !== at) {
    throw new EdgeAssertionError("no_email");
  }

  const custom = payload.custom && typeof payload.custom === "object" && !Array.isArray(payload.custom)
    ? payload.custom as Record<string, unknown>
    : {};
  const subjectClaim = binding.subjectClaim;
  const rawSubject = subjectClaim ? custom[subjectClaim] : undefined;
  const idpSubject = typeof rawSubject === "string" && rawSubject.trim() !== ""
    ? rawSubject.trim()
    : null;
  const customName = typeof custom.name === "string" && custom.name.trim() !== ""
    ? custom.name.trim()
    : null;

  return {
    email,
    cfSub,
    idpSubject,
    identityNonce: typeof payload.identity_nonce === "string" ? payload.identity_nonce : null,
    customName,
  };
}

/** email は小文字化 + trim のみ。 plus-address やドットは同一視しない。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertEmailDomainAllowed(binding: EdgeIdpBinding, email: string): void {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!binding.allowedEmailDomains.includes(domain)) {
    throw new EdgeAssertionError("domain");
  }
}

async function enforceRateLimit(projectKey: string, subject: string): Promise<void> {
  // Do not put email/IdP subject PII in Redis key names. checkRateLimit uses an
  // atomic Lua increment+expiry so a crash cannot leave a permanent counter.
  const subjectHash = createHash("sha256").update(subject).digest("hex");
  try {
    await checkRateLimit(
      `edge_assertion:${projectKey}:${subjectHash}`,
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_SEC,
    );
  } catch {
    // Redis unavailability also fails closed: no assertion should bypass the
    // abuse control merely because its state store is unavailable.
    throw new EdgeAssertionError("rate_limited");
  }
}

// ── 2. ID 解決とプロビジョニング ─────────────────────────────

async function resolveUser(
  binding: EdgeIdpBinding,
  claims: AssertionClaims,
  identity: EdgeIdentity | null,
): Promise<string> {
  const bySubject = claims.idpSubject
    ? await findIdentityBySubject(binding, claims.idpSubject)
    : null;

  if (bySubject) {
    // subject 一致 = 同一人物。 email 変更に追従する。
    await followEmailChange(bySubject.userId, bySubject.email, claims.email);
    await touchIdentity(bySubject.id, binding, claims, identity);
    await applyIdentityDisplayName(bySubject.userId, identity, claims);
    return bySubject.userId;
  }

  const byEmail = await findIdentityByEmail(binding, claims.email);
  if (byEmail) {
    // IdP 移行等で subject が変わっていても email で追従する。
    await touchIdentity(byEmail.id, binding, claims, identity);
    await applyIdentityDisplayName(byEmail.userId, identity, claims);
    return byEmail.userId;
  }

  const existingUser = await findUserByEmail(claims.email);
  if (existingUser) {
    if (binding.provisioning === "invite_only") throw new EdgeAssertionError("not_provisioned");
    await linkIdentity(existingUser.id, binding, claims, identity);
    await applyIdentityDisplayName(existingUser.id, identity, claims);
    return existingUser.id;
  }

  if (binding.provisioning !== "auto") throw new EdgeAssertionError("not_provisioned");
  const userId = await provisionUser(binding, claims, identity);
  await linkIdentity(userId, binding, claims, identity);
  return userId;
}

interface IdentityRow {
  id: string;
  userId: string;
  email: string;
}

async function findIdentityBySubject(
  binding: EdgeIdpBinding,
  idpSubject: string,
): Promise<IdentityRow | null> {
  const rows = await db.select({
    id: schema.edgeIdentities.id,
    userId: schema.edgeIdentities.userId,
    email: schema.edgeIdentities.email,
  }).from(schema.edgeIdentities).where(and(
    eq(schema.edgeIdentities.provider, binding.provider),
    eq(schema.edgeIdentities.teamDomain, binding.teamDomain),
    eq(schema.edgeIdentities.idpSubject, idpSubject),
  )).limit(1);
  return rows[0] ?? null;
}

async function findIdentityByEmail(
  binding: EdgeIdpBinding,
  email: string,
): Promise<IdentityRow | null> {
  const rows = await db.select({
    id: schema.edgeIdentities.id,
    userId: schema.edgeIdentities.userId,
    email: schema.edgeIdentities.email,
  }).from(schema.edgeIdentities).where(and(
    eq(schema.edgeIdentities.provider, binding.provider),
    eq(schema.edgeIdentities.teamDomain, binding.teamDomain),
    eq(schema.edgeIdentities.email, email),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * 既存ユーザを email で引く。
 *
 * `users.email` は他の登録経路 (password / OAuth) では小文字化されずに入るため、
 * `idx_users_email` (素の unique index) は大文字小文字を区別する。 ここで完全一致
 * 比較にすると `Taro@example.co.jp` で登録済みの本人を取り逃がし、 provisioning
 * が `auto` なら小文字の二重アカウントを静かに作ってしまう (`link_only` /
 * `invite_only` なら本人なのに `not_provisioned` で弾く)。 引数は
 * normalizeEmail() 済みなので、 DB 側も lower() を通して突き合わせる。
 */
async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const rows = await db.select({ id: schema.users.id })
    .from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  return rows[0] ?? null;
}

/**
 * subject 一致で email が変わっていたら users.email を更新する。
 *
 * 新しい email が既に別ユーザのものだった場合は、 unique index 違反で落とさず
 * `email_conflict` で拒否する (統合が必要なので admin の手当てに回す)。
 */
async function followEmailChange(userId: string, knownEmail: string, newEmail: string): Promise<void> {
  if (knownEmail === newEmail) return;

  // 衝突判定も findUserByEmail() と同じ大文字小文字を無視する比較にする。
  // ここだけ完全一致にすると、 大文字混じりで登録済みの別ユーザを見落として
  // users.email の更新が unique index 違反 (= 生の DB エラー) で落ちる。
  const conflict = await db.select({ id: schema.users.id })
    .from(schema.users)
    .where(and(sql`lower(${schema.users.email}) = ${newEmail}`, ne(schema.users.id, userId)))
    .limit(1);
  if (conflict.length > 0) throw new EdgeAssertionError("email_conflict");

  await db.update(schema.users)
    .set({ email: newEmail, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}

async function provisionUser(
  binding: EdgeIdpBinding,
  claims: AssertionClaims,
  identity: EdgeIdentity | null,
): Promise<string> {
  const localPart = claims.email.slice(0, claims.email.lastIndexOf("@"));
  const login = await uniqueLogin(localPart);
  const userId = randomUUID();

  // 表示名は email の @ より前を暫定値にする。 IdP の氏名が取れるかは CF / IdP の
  // 設定次第なので、 そこにログイン成立を依存させない (spec §5.2.2)。
  await db.insert(schema.users).values({
    id: userId,
    login,
    displayName: localPart,
    displayNameSource: "provisional",
    email: claims.email,
    role: binding.defaultRole,
    passwordHash: null,
  });

  await applyIdentityDisplayName(userId, identity, claims);
  return userId;
}

async function uniqueLogin(base: string): Promise<string> {
  const seed = base.replace(/[^a-zA-Z0-9._-]/g, "") || "user";
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? seed : `${seed}${suffix}`;
    const taken = await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.login, candidate)).limit(1);
    if (taken.length === 0) return candidate;
  }
  return `${seed}-${randomUUID().slice(0, 8)}`;
}

/**
 * IdP 由来の氏名で表示名を更新する。
 *
 * ユーザ自身が設定した表示名 (`display_name_source = 'user'`) は二度と上書きしない。
 */
async function applyIdentityDisplayName(
  userId: string,
  identity: EdgeIdentity | null,
  claims: AssertionClaims,
): Promise<void> {
  const name = identity?.name ?? claims.customName;
  if (!name) return;

  await db.update(schema.users)
    .set({ displayName: name, displayNameSource: "idp", updatedAt: new Date() })
    .where(and(
      eq(schema.users.id, userId),
      ne(schema.users.displayNameSource, "user"),
    ));
}

async function touchLastLogin(userId: string, at: Date): Promise<void> {
  await db.update(schema.users)
    .set({ lastLoginAt: at, updatedAt: at })
    .where(eq(schema.users.id, userId));
}

async function linkIdentity(
  userId: string,
  binding: EdgeIdpBinding,
  claims: AssertionClaims,
  identity: EdgeIdentity | null,
): Promise<void> {
  await db.insert(schema.edgeIdentities).values({
    id: randomUUID(),
    provider: binding.provider,
    teamDomain: binding.teamDomain,
    email: claims.email,
    idpSubject: claims.idpSubject,
    userId,
    cfSub: claims.cfSub,
    cfUserUuid: identity?.userUuid ?? null,
    idpType: identity?.idpType ?? null,
    idpName: identity?.name ?? null,
    groups: identity?.groups ?? [],
    lastSeenAt: new Date(),
  });
}

async function touchIdentity(
  identityId: string,
  binding: EdgeIdpBinding,
  claims: AssertionClaims,
  identity: EdgeIdentity | null,
): Promise<void> {
  await db.update(schema.edgeIdentities).set({
    email: claims.email,
    // subject 未設定の binding では既存値を消さない。
    idpSubject: claims.idpSubject ?? sql`${schema.edgeIdentities.idpSubject}`,
    cfSub: claims.cfSub,
    cfUserUuid: identity?.userUuid ?? null,
    idpType: identity?.idpType ?? null,
    idpName: identity?.name ?? null,
    // 取得失敗時は空にする。 前回値を流用しない (offboarding 直後の権限残留を防ぐ)。
    groups: identity?.groups ?? [],
    lastSeenAt: new Date(),
  }).where(eq(schema.edgeIdentities.id, identityId));
}
