import { pgTable, text, uuid, timestamp, jsonb, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const workloadPrincipals = pgTable('workload_principals', {
  id: text('id').primaryKey(),
  clientId: uuid('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
export const workloadKeys = pgTable('workload_keys', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull().unique().references(() => workloadPrincipals.id),
  publicKeyPem: text('public_key_pem').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
export const workloadGrants = pgTable('workload_grants', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull().references(() => workloadPrincipals.id),
  audience: text('audience').notNull().references(() => workloadPrincipals.id),
  action: text('action').notNull(), resource: text('resource').notNull(),
  keys: jsonb('keys').$type<string[] | null>(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [uniqueIndex('workload_grants_active_unique').on(table.subject, table.audience, table.action, table.resource)
  .where(sql`${table.revokedAt} IS NULL`)]);
export const workloadTokens = pgTable('workload_tokens', {
  id: uuid('id').primaryKey(), tokenHash: text('token_hash').notNull().unique(),
  subject: text('subject').notNull().references(() => workloadPrincipals.id),
  audience: text('audience').notNull().references(() => workloadPrincipals.id),
  keyId: uuid('key_id').notNull().references(() => workloadKeys.id),
  grantId: uuid('grant_id').notNull().references(() => workloadGrants.id),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [check('workload_token_ttl', sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '60 seconds'`)]);
