/**
 * Drizzle ORM スキーマ定義
 *
 * 既存の PostgreSQL マイグレーション (migrations/001-008) に対応。
 */

import {
  pgTable, text, uuid, timestamp, bigint, boolean, jsonb, integer, primaryKey, uniqueIndex, index,
} from "drizzle-orm/pg-core";

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
  googleId: text("google_id").unique(),
  googleAccessToken: text("google_access_token"),
  googleRefreshToken: text("google_refresh_token"),
  googleTokenExpiresAt: bigint("google_token_expires_at", { mode: "number" }),
  googleScopes: jsonb("google_scopes"),

  // MFA
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
  extra: jsonb("extra").notNull().default({}),
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
