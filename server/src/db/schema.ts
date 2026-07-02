/**
 * Drizzle ORM スキーマ定義
 *
 * 既存の PostgreSQL マイグレーション (migrations/001-008) に対応。
 */

import {
  pgTable, text, uuid, timestamp, bigint, boolean, jsonb, integer, customType, primaryKey, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// drizzle 標準には bytea 型がないので簡易 custom type で代用 (= raw Buffer / Uint8Array)
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() { return "bytea"; },
});

// ── Users ────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).unique(),
  login: text("login").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  email: text("email"),
  role: text("role").notNull().default("general"),
  passwordHash: text("password_hash"),

  // Google OAuth
  // accessToken / refreshToken は保存時暗号化 (lib/crypto/secret-box, AES-256-GCM)。
  // 書込みは必ず encryptSecret() を通すこと。読出し時は decryptSecret()。RULE.md §7.2。
  googleId: text("google_id").unique(),
  googleAccessToken: text("google_access_token"),
  googleRefreshToken: text("google_refresh_token"),
  googleTokenExpiresAt: bigint("google_token_expires_at", { mode: "number" }),
  googleScopes: jsonb("google_scopes"),

  // MFA
  // totpSecret は秘密鍵。MFA 配線時は encryptSecret()/decryptSecret() を必ず通す
  // こと (現状未配線で書込みコードは無い)。RULE.md §7.2。
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  phoneNumber: text("phone_number"),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaMethods: jsonb("mfa_methods").notNull().default([]),

  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_users_email").on(t.email),
]);

// ── Refresh Sessions ─────────────────────────────────────────

export const refreshSessions = pgTable("refresh_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshToken: text("refresh_token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // ローテーション済み検出用。 非 null = この token は既に refresh に使われた
  // (= 再提示されたら盗用とみなす)。
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_refresh_sessions_user_id").on(t.userId),
  index("idx_refresh_sessions_token").on(t.refreshToken),
]);

// ── Verification Codes (MFA) ─────────────────────────────────

export const verificationCodes = pgTable("verification_codes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  method: text("method").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_verification_codes_user_id").on(t.userId),
]);

// ── Trusted Devices (本人確認) ───────────────────────────────

export const trustedDevices = pgTable("trusted_devices", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceHash: text("device_hash").notNull(),
  label: text("label").notNull(),
  machineInfo: jsonb("machine_info").notNull().default({}),
  browserInfo: jsonb("browser_info").notNull().default({}),
  geoInfo: jsonb("geo_info").notNull().default({}),
  lastIp: text("last_ip"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  index("idx_trusted_devices_user").on(t.userId),
  index("idx_trusted_devices_user_last_seen").on(t.userId, t.lastSeenAt),
]);

// ── Passkeys (WebAuthn / FIDO2) ──────────────────────────────
// FaceID / Touch ID / Windows Hello / Android 生体認証 / 物理キー の公開鍵を保存。
// 1 user に複数 (端末ごと / 同期パスキーで一括) 登録可能。

export const passkeys = pgTable("passkeys", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),         // base64url
  publicKey: bytea("public_key").notNull(),               // COSE bytes
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  deviceType: text("device_type").notNull().default("singleDevice"),
  backedUp: boolean("backed_up").notNull().default(false),
  transports: jsonb("transports").notNull().default([]),  // ["internal"] / ["usb","nfc"] 等
  nickname: text("nickname"),                              // 表示用 (例: "iPhone 15", "Yubikey 5C")
  aaguid: text("aaguid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("idx_passkeys_credential_id").on(t.credentialId),
  index("idx_passkeys_user").on(t.userId, t.createdAt),
]);

// ── Organizations ────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable("organization_members", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.userId] }),
  index("idx_org_members_user").on(t.userId),
]);

// ── Project Definitions ──────────────────────────────────────

export const projectDefinitions = pgTable("project_definitions", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  dataSchema: jsonb("data_schema").notNull().default({}),
  commands: jsonb("commands").notNull().default([]),
  pluginRepository: text("plugin_repository").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationProjects = pgTable("organization_projects", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectDefinitionId: uuid("project_definition_id").notNull().references(() => projectDefinitions.id, { onDelete: "cascade" }),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.projectDefinitionId] }),
]);

// ── Operation Logs ───────────────────────────────────────────

export const operationLogs = pgTable("operation_logs", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  sessionId: text("session_id").notNull(),
  method: text("method").notNull(),
  params: jsonb("params").notNull().default({}),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_operation_logs_user").on(t.userId),
  index("idx_operation_logs_session").on(t.sessionId),
  index("idx_operation_logs_method").on(t.method),
  index("idx_operation_logs_created").on(t.createdAt),
]);

// ── Tool Clients ─────────────────────────────────────────────

export const toolClients = pgTable("tool_clients", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scopes: jsonb("scopes").notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_tool_clients_client_id").on(t.clientId),
  index("idx_tool_clients_owner").on(t.ownerUserId),
]);

// ── User Profiles ────────────────────────────────────────────

export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  roleTitle: text("role_title").notNull().default(""),
  bio: text("bio").notNull().default(""),
  expertise: jsonb("expertise").notNull().default([]),
  hobbies: jsonb("hobbies").notNull().default([]),
  privacy: jsonb("privacy").notNull().default({
    bio: true, roleTitle: true, expertise: true, hobbies: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Projects (User data) ─────────────────────────────────────

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_projects_user_id").on(t.userId),
]);

export const projectSettings = pgTable("project_settings", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  settingKey: text("setting_key").notNull(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.settingKey] }),
]);

// ── Service Registry ─────────────────────────────────────────

export const serviceRegistry = pgTable("service_registry", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  serviceSecretHash: text("service_secret_hash").notNull(),
  endpointUrl: text("endpoint_url").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const serviceTickets = pgTable("service_tickets", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => serviceRegistry.id, { onDelete: "cascade" }),
  ticketCode: text("ticket_code").notNull().unique(),
  userData: jsonb("user_data").notNull(),
  organizationId: uuid("organization_id"),
  scopes: jsonb("scopes").notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumed: boolean("consumed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_service_tickets_code").on(t.ticketCode),
]);

// ── Data Opt-outs ────────────────────────────────────────────

export const userDataOptouts = pgTable("user_data_optouts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(),
  categoryKey: text("category_key").notNull(),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.serviceId, t.categoryKey] }),
  index("idx_user_data_optouts_user").on(t.userId),
  index("idx_user_data_optouts_user_service").on(t.userId, t.serviceId),
]);

// ── Managed Projects (動的プロジェクト管理) ──────────────────

export const managedProjects = pgTable("managed_projects", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  schemaDefinition: jsonb("schema_definition").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_managed_projects_client_id").on(t.clientId),
]);

// ── Relay Pairs (service adapter 同士の peer 許可) ────────────
//
// 2 つの managedProject が直接 WS で繋がる許可リスト.
// bidirectional=TRUE なら A→B / B→A どちらも開通. FALSE なら
// from→to のみ (使い分けは admin UI 側).

export const relayPairs = pgTable("relay_pairs", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromProjectKey: text("from_project_key").notNull()
    .references(() => managedProjects.key, { onDelete: "cascade" }),
  toProjectKey: text("to_project_key").notNull()
    .references(() => managedProjects.key, { onDelete: "cascade" }),
  bidirectional: boolean("bidirectional").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_relay_pairs_from_to").on(t.fromProjectKey, t.toProjectKey),
  index("idx_relay_pairs_from").on(t.fromProjectKey),
  index("idx_relay_pairs_to").on(t.toProjectKey),
]);

export const projectDefinitionHistory = pgTable("project_definition_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectKey: text("project_key").notNull().references(() => managedProjects.key, { onDelete: "cascade" }),
  definition: jsonb("definition").notNull(),
  version: integer("version").notNull().default(1),
  appliedBy: uuid("applied_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_project_def_history_key").on(t.projectKey),
]);

// ── OIDC Clients (Cernere を IdP とする OpenID Connect RP 登録) ──
// Cloudflare Access 等の Relying Party を登録する。 client_secret は bcrypt
// ハッシュで保存し、 redirect_uris は完全一致でのみ許可する (open redirect 防止)。

export const oidcClients = pgTable("oidc_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  name: text("name").notNull(),
  // 許可する redirect_uri の完全一致リスト (例: Cloudflare の callback URL)
  redirectUris: jsonb("redirect_uris").notNull().default([]),
  // 許可スコープ (既定 openid email profile)
  scopes: jsonb("scopes").notNull().default(["openid", "email", "profile"]),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oidc_clients_client_id").on(t.clientId),
]);

// ── Project OAuth Tokens (プロジェクト別 OAuth トークンストレージ) ──
// Cernere を個人データの単一情報源とするため、各プロジェクトは
// OAuth refresh/access token を自前で保管せず Cernere に預ける。

export const projectOauthTokens = pgTable("project_oauth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectKey: text("project_key").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  // 機密トークンは保存時に暗号化する (RULE.md §7.2)。書込/読出は必ず
  // project/oauth-token-crypto.ts (encryptToken/decryptToken = encryptSecret 規律) を
  // 経由すること。users.google_access_token/google_refresh_token と同一規律。
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  tokenType: text("token_type"),
  scope: text("scope"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_oauth_tokens_project_user_provider").on(t.projectKey, t.userId, t.provider),
  index("idx_oauth_tokens_project_user").on(t.projectKey, t.userId),
  index("idx_oauth_tokens_project_provider").on(t.projectKey, t.provider),
]);
