/** Persistent enterprise trust configuration and membership checks. @implements SPEC-ENTERPRISE-CONNECTION */
import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { enterpriseConnections, enterpriseIdentities, organizationMembers, organizations, managedProjects, oidcClients, users } from "../db/schema.js";
import { AppError } from "../error.js";
import { parseConnection, identityInput } from "./connection-contract.js";

export type EnterpriseConnection = typeof enterpriseConnections.$inferSelect;
export async function findConnection(projectKey: string): Promise<EnterpriseConnection | null> {
  return (await db.select().from(enterpriseConnections).where(eq(enterpriseConnections.projectKey, projectKey)).limit(1))[0] ?? null;
}
export async function connectionForClient(clientId: string): Promise<EnterpriseConnection | null> {
  return (await db.select().from(enterpriseConnections).where(eq(enterpriseConnections.oidcClientId, clientId)).limit(1))[0] ?? null;
}
export async function requireConnection(projectKey: string): Promise<EnterpriseConnection> {
  const connection = await findConnection(projectKey);
  if (!connection?.isActive) throw AppError.forbidden("Enterprise connection is disabled or missing");
  const project = (await db.select({ active: managedProjects.isActive }).from(managedProjects).where(eq(managedProjects.key, projectKey)).limit(1))[0];
  const client = (await db.select({ active: oidcClients.isActive, redirects: oidcClients.redirectUris }).from(oidcClients)
    .where(eq(oidcClients.clientId, connection.oidcClientId)).limit(1))[0];
  const callback = "https://" + connection.teamDomain + "/cdn-cgi/access/callback";
  if (!project?.active || !client?.active || !Array.isArray(client.redirects) || client.redirects.length !== 1 || client.redirects[0] !== callback) {
    throw AppError.forbidden("Enterprise application or OIDC client is disabled or changed");
  }
  return connection;
}

export async function requireMembership(connection: EnterpriseConnection, userId: string): Promise<{ role: string; joinedAt: string; authenticationRevision: number }> {
  const rows = await db.select({ role: organizationMembers.role, joinedAt: organizationMembers.joinedAt, revision: users.mfaRevision })
    .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, connection.organizationId), eq(organizationMembers.userId, userId))).limit(1);
  if (!rows[0]) throw AppError.forbidden("Organization membership is required");
  return { role: rows[0].role, joinedAt: rows[0].joinedAt.toISOString(), authenticationRevision: rows[0].revision };
}

/** Mirrors the admin UI contract in frontend/src/pages/admin/enterprise/types.ts. */
export interface EnterpriseConfiguration {
  connections: EnterpriseConnection[];
  identities: Array<{ projectKey: string; userId: string; isActive: boolean }>;
  organizations: Array<{ id: string; name: string }>;
  projects: Array<{ key: string; name: string; isActive: boolean }>;
  clients: Array<{ clientId: string; name: string; redirectUris: unknown; isActive: boolean }>;
  members: Array<{ organizationId: string; userId: string; name: string; role: string }>;
}

export async function listEnterpriseConfiguration(): Promise<EnterpriseConfiguration> {
  const [connections, identities, orgs, projects, clients, members] = await Promise.all([
    db.select().from(enterpriseConnections),
    db.select({ projectKey: enterpriseIdentities.projectKey, userId: enterpriseIdentities.userId, isActive: enterpriseIdentities.isActive }).from(enterpriseIdentities),
    db.select({ id: organizations.id, name: organizations.name }).from(organizations),
    db.select({ key: managedProjects.key, name: managedProjects.name, isActive: managedProjects.isActive }).from(managedProjects),
    db.select({ clientId: oidcClients.clientId, name: oidcClients.name, redirectUris: oidcClients.redirectUris, isActive: oidcClients.isActive }).from(oidcClients),
    db.select({ organizationId: organizationMembers.organizationId, userId: users.id, name: users.displayName, role: organizationMembers.role })
      .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)),
  ]);
  return { connections, identities, organizations: orgs, projects, clients, members };
}

export async function saveConnection(payload: unknown): Promise<EnterpriseConnection> {
  const input = parseConnection(payload);
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(enterpriseConnections).where(eq(enterpriseConnections.projectKey, input.projectKey)).for("update"))[0];
    if ((current?.revision ?? null) !== input.expectedRevision) throw AppError.conflict("Connection changed. Reload before saving.");
    const client = (await tx.select().from(oidcClients).where(eq(oidcClients.clientId, input.oidcClientId)).for("share"))[0];
    const project = (await tx.select().from(managedProjects).where(eq(managedProjects.key, input.projectKey)).for("share"))[0];
    const org = (await tx.select().from(organizations).where(eq(organizations.id, input.organizationId)).for("share"))[0];
    const callback = "https://" + input.teamDomain + "/cdn-cgi/access/callback";
    if (!client || !project || !org || !Array.isArray(client.redirectUris) || client.redirectUris.length !== 1 || client.redirectUris[0] !== callback) {
      throw AppError.badRequest("Select a registered organization, project, and OIDC client with the exact Cloudflare callback");
    }
    if (input.isActive && (!client.isActive || !project.isActive)) throw AppError.badRequest("Activate the project and OIDC client first");
    const { expectedRevision: _expected, ...settings } = input;
    const values = { ...settings, revision: randomUUID(), updatedAt: new Date() };
    const rows = current ? await tx.update(enterpriseConnections).set(values).where(eq(enterpriseConnections.projectKey, input.projectKey)).returning()
      : await tx.insert(enterpriseConnections).values(values).returning();
    // Changing a tenant/organization must never carry identities into the new trust domain.
    if (current && (current.teamDomain !== input.teamDomain || current.organizationId !== input.organizationId)) {
      await tx.delete(enterpriseIdentities).where(eq(enterpriseIdentities.projectKey, input.projectKey));
    }
    return rows[0];
  });
}

export function subjectHash(subject: string): string { return createHash("sha256").update(subject).digest("hex"); }

export async function saveEnterpriseIdentity(payload: unknown): Promise<void> {
  const parsed = identityInput.safeParse(payload);
  if (!parsed.success) throw AppError.badRequest("Select a user and the Cloudflare subject UUID");
  const input = parsed.data;
  await db.transaction(async (tx) => {
    const connection = (await tx.select().from(enterpriseConnections).where(eq(enterpriseConnections.projectKey, input.projectKey)).for("share"))[0];
    if (!connection) throw AppError.notFound("Enterprise connection not found");
    const member = (await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, connection.organizationId), eq(organizationMembers.userId, input.userId))).for("share"))[0];
    if (!member) throw AppError.badRequest("Add this user to the organization first");
    const digest = subjectHash(input.cloudflareSubject);
    const existing = (await tx.select().from(enterpriseIdentities).where(and(eq(enterpriseIdentities.projectKey, input.projectKey), eq(enterpriseIdentities.subjectHash, digest))).for("update"))[0];
    if (existing && existing.userId !== input.userId) throw AppError.conflict("Cloudflare subject is already assigned");
    await tx.delete(enterpriseIdentities).where(and(eq(enterpriseIdentities.projectKey, input.projectKey), eq(enterpriseIdentities.userId, input.userId)));
    await tx.insert(enterpriseIdentities).values({ projectKey: input.projectKey, userId: input.userId, subjectHash: digest, isActive: input.isActive, revision: randomUUID() });
  });
}

/** Reports whether an assignment was actually revoked, so callers never see a false success. */
export async function revokeEnterpriseUser(projectKey: string, userId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw AppError.badRequest("Invalid user ID");
  const rows = await db.update(enterpriseIdentities).set({ isActive: false, revision: randomUUID() })
    .where(and(eq(enterpriseIdentities.projectKey, projectKey), eq(enterpriseIdentities.userId, userId)))
    .returning({ userId: enterpriseIdentities.userId });
  return rows.length > 0;
}
