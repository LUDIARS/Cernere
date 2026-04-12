/**
 * WebSocket コマンドディスパッチャ
 *
 * module_request メッセージを受け取り、ビジネスロジックにルーティングする。
 * 全操作は operation_logs テーブルに��録される。
 */

import { db } from "./db/connection.js";
import * as schema from "./db/schema.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { AppError } from "./error.js";

export async function dispatch(
  userId: string,
  sessionId: string,
  module: string,
  action: string,
  payload: unknown,
): Promise<unknown> {
  const method = `${capitalize(module)}.${capitalize(action)}`;
  const params = payload ?? {};

  let result: unknown;
  let status = "ok";
  let error: string | undefined;

  try {
    result = await execute(userId, module, action, payload as Record<string, unknown> | undefined);
  } catch (err) {
    status = "error";
    error = (err as Error).message;
    throw err;
  } finally {
    await db.insert(schema.operationLogs).values({
      id: crypto.randomUUID(),
      userId,
      sessionId,
      method,
      params,
      status,
      error: error ?? null,
    }).catch(() => {});
  }

  return result;
}

async function execute(
  userId: string,
  module: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  switch (module) {
    case "organization": return organizationCmd(userId, action, payload);
    case "member": return memberCmd(userId, action, payload);
    case "project_definition": return projectDefCmd(userId, action, payload);
    case "org_project": return orgProjectCmd(userId, action, payload);
    case "user": return userCmd(userId, action, payload);
    case "profile": return profileCmd(userId, action, payload);
    case "managed_project": return managedProjectCmd(userId, action, payload);
    default:
      throw AppError.badRequest(`Unknown module: ${module}`);
  }
}

// -- Organization --

async function organizationCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "list": {
      const memberships = await db.select({ orgId: schema.organizationMembers.organizationId })
        .from(schema.organizationMembers).where(eq(schema.organizationMembers.userId, userId));
      const orgIds = memberships.map((m) => m.orgId);
      if (orgIds.length === 0) return [];
      const orgs = await db.select().from(schema.organizations)
        .where(inArray(schema.organizations.id, orgIds));
      return orgs;
    }
    case "get": {
      const orgId = requireStr(p, "organizationId");
      const org = await db.select().from(schema.organizations)
        .where(eq(schema.organizations.id, orgId)).limit(1);
      if (org.length === 0) throw AppError.notFound("Organization not found");
      return org[0];
    }
    case "create": {
      await requireSystemAdmin(userId);
      const name = requireStr(p, "name");
      const slug = requireStr(p, "slug");
      const description = optStr(p, "description") ?? "";
      const id = crypto.randomUUID();
      const now = new Date();
      await db.insert(schema.organizations).values({
        id, name, slug, description, createdBy: userId, createdAt: now, updatedAt: now,
      });
      await db.insert(schema.organizationMembers).values({
        organizationId: id, userId, role: "owner", joinedAt: now,
      });
      return { id, name, slug, description, createdBy: userId, createdAt: now.toISOString() };
    }
    case "presence": {
      const orgId = requireStr(p, "organizationId");
      const { getOrgPresence } = await import("./ws/events.js");
      return getOrgPresence(orgId);
    }
    case "update": {
      await requireSystemAdmin(userId);
      const orgId = requireStr(p, "organizationId");
      await db.update(schema.organizations).set({
        name: requireStr(p, "name"),
        description: optStr(p, "description"),
        updatedAt: new Date(),
      }).where(eq(schema.organizations.id, orgId));
      return { ok: true };
    }
    case "delete": {
      await requireSystemAdmin(userId);
      const orgId = requireStr(p, "organizationId");
      await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      return { ok: true };
    }
    default: throw AppError.badRequest(`Unknown organization action: ${action}`);
  }
}

// -- Member --

async function memberCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "list": {
      const orgId = requireStr(p, "organizationId");
      const members = await db.select({
        userId: schema.organizationMembers.userId,
        role: schema.organizationMembers.role,
        joinedAt: schema.organizationMembers.joinedAt,
        login: schema.users.login,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        email: schema.users.email,
      }).from(schema.organizationMembers)
        .innerJoin(schema.users, eq(schema.organizationMembers.userId, schema.users.id))
        .where(eq(schema.organizationMembers.organizationId, orgId));
      return members;
    }
    case "add": {
      const orgId = requireStr(p, "organizationId");
      const targetUserId = requireStr(p, "userId");
      const role = optStr(p, "role") ?? "member";
      await requireOrgRole(userId, orgId, ["admin", "owner", "maintainer"]);
      await db.insert(schema.organizationMembers).values({
        organizationId: orgId, userId: targetUserId, role, joinedAt: new Date(),
      });
      return { ok: true };
    }
    case "update_role": {
      const orgId = requireStr(p, "organizationId");
      const targetUserId = requireStr(p, "userId");
      const role = requireStr(p, "role");
      await requireOrgRole(userId, orgId, ["admin", "owner", "maintainer"]);
      await db.update(schema.organizationMembers).set({ role })
        .where(and(
          eq(schema.organizationMembers.organizationId, orgId),
          eq(schema.organizationMembers.userId, targetUserId),
        ));
      return { ok: true };
    }
    case "remove": {
      const orgId = requireStr(p, "organizationId");
      const targetUserId = requireStr(p, "userId");
      if (targetUserId !== userId) {
        await requireOrgRole(userId, orgId, ["admin", "owner", "maintainer"]);
      }
      await db.delete(schema.organizationMembers)
        .where(and(
          eq(schema.organizationMembers.organizationId, orgId),
          eq(schema.organizationMembers.userId, targetUserId),
        ));
      return { ok: true };
    }
    default: throw AppError.badRequest(`Unknown member action: ${action}`);
  }
}

// -- ProjectDefinition --

async function projectDefCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "list":
      return db.select().from(schema.projectDefinitions);
    case "get": {
      const id = requireStr(p, "id");
      const rows = await db.select().from(schema.projectDefinitions)
        .where(eq(schema.projectDefinitions.id, id)).limit(1);
      if (rows.length === 0) throw AppError.notFound("Project definition not found");
      return rows[0];
    }
    case "create": {
      await requireSystemAdmin(userId);
      const id = crypto.randomUUID();
      const now = new Date();
      await db.insert(schema.projectDefinitions).values({
        id,
        code: requireStr(p, "code"),
        name: requireStr(p, "name"),
        dataSchema: p?.dataSchema ?? {},
        commands: p?.commands ?? [],
        pluginRepository: optStr(p, "pluginRepository") ?? "",
        createdAt: now, updatedAt: now,
      });
      return { id };
    }
    case "update": {
      await requireSystemAdmin(userId);
      const id = requireStr(p, "id");
      await db.update(schema.projectDefinitions).set({
        name: requireStr(p, "name"),
        dataSchema: p?.dataSchema ?? {},
        commands: p?.commands ?? [],
        pluginRepository: optStr(p, "pluginRepository"),
        updatedAt: new Date(),
      }).where(eq(schema.projectDefinitions.id, id));
      return { ok: true };
    }
    case "delete": {
      await requireSystemAdmin(userId);
      await db.delete(schema.projectDefinitions).where(eq(schema.projectDefinitions.id, requireStr(p, "id")));
      return { ok: true };
    }
    default: throw AppError.badRequest(`Unknown project_definition action: ${action}`);
  }
}

// -- OrganizationProject --

async function orgProjectCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "list": {
      const orgId = requireStr(p, "organizationId");
      const rows = await db.select().from(schema.organizationProjects)
        .innerJoin(schema.projectDefinitions,
          eq(schema.organizationProjects.projectDefinitionId, schema.projectDefinitions.id))
        .where(eq(schema.organizationProjects.organizationId, orgId));
      return rows.map((r) => r.project_definitions);
    }
    case "enable": {
      const orgId = requireStr(p, "organizationId");
      await requireOrgRole(userId, orgId, ["admin", "owner", "maintainer"]);
      await db.insert(schema.organizationProjects).values({
        organizationId: orgId,
        projectDefinitionId: requireStr(p, "projectDefinitionId"),
      });
      return { ok: true };
    }
    case "disable": {
      const orgId = requireStr(p, "organizationId");
      await requireOrgRole(userId, orgId, ["admin", "owner", "maintainer"]);
      await db.delete(schema.organizationProjects).where(and(
        eq(schema.organizationProjects.organizationId, orgId),
        eq(schema.organizationProjects.projectDefinitionId, requireStr(p, "projectDefinitionId")),
      ));
      return { ok: true };
    }
    default: throw AppError.badRequest(`Unknown org_project action: ${action}`);
  }
}

// -- User --

async function userCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "get": {
      const targetId = requireStr(p, "userId");
      const rows = await db.select().from(schema.users)
        .where(eq(schema.users.id, targetId)).limit(1);
      if (rows.length === 0) throw AppError.notFound("User not found");
      const u = rows[0];
      return {
        id: u.id, login: u.login, displayName: u.displayName,
        avatarUrl: u.avatarUrl, email: u.email, role: u.role,
      };
    }
    case "search": {
      const query = requireStr(p, "query");
      if (query.length < 2) throw AppError.badRequest("Query must be at least 2 characters");
      const rows = await db.select({
        id: schema.users.id,
        login: schema.users.login,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        email: schema.users.email,
      }).from(schema.users)
        .where(
          sql`(${schema.users.login} ILIKE ${'%' + query + '%'}
           OR ${schema.users.displayName} ILIKE ${'%' + query + '%'}
           OR ${schema.users.email} ILIKE ${'%' + query + '%'})`
        )
        .limit(10);
      return rows;
    }
    case "get_profile": {
      // 他ユーザーの公開プロフィール (privacy フィルタ付き)
      const targetId = requireStr(p, "userId");
      const userRows = await db.select().from(schema.users)
        .where(eq(schema.users.id, targetId)).limit(1);
      if (userRows.length === 0) throw AppError.notFound("User not found");
      const u = userRows[0];

      const profileRows = await db.select().from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, targetId)).limit(1);
      const profile = profileRows[0];
      const privacy = (profile?.privacy ?? { bio: true, roleTitle: true, expertise: true, hobbies: true }) as Record<string, boolean>;

      return {
        userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl,
        roleTitle: privacy.roleTitle ? (profile?.roleTitle ?? "") : undefined,
        bio: privacy.bio ? (profile?.bio ?? "") : undefined,
        expertise: privacy.expertise ? (profile?.expertise ?? []) : undefined,
        hobbies: privacy.hobbies ? (profile?.hobbies ?? []) : undefined,
      };
    }
    default:
      throw AppError.badRequest(`Unknown user action: ${action}`);
  }
}

// -- Profile (自分のプロフィール) --

async function profileCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "get": {
      const rows = await db.select().from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId)).limit(1);
      if (rows.length === 0) {
        return {
          userId, roleTitle: "", bio: "", expertise: [], hobbies: [],
          privacy: { bio: true, roleTitle: true, expertise: true, hobbies: true },
        };
      }
      return rows[0];
    }
    case "update": {
      const now = new Date();
      const existing = await db.select({ userId: schema.userProfiles.userId })
        .from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);

      if (existing.length === 0) {
        await db.insert(schema.userProfiles).values({
          userId,
          roleTitle: optStr(p, "roleTitle") ?? "",
          bio: optStr(p, "bio") ?? "",
          expertise: (p?.expertise as string[]) ?? [],
          hobbies: (p?.hobbies as string[]) ?? [],
          privacy: { bio: true, roleTitle: true, expertise: true, hobbies: true },
          createdAt: now, updatedAt: now,
        });
      } else {
        const updates: Record<string, unknown> = { updatedAt: now };
        if (p?.roleTitle !== undefined) updates.roleTitle = p.roleTitle;
        if (p?.bio !== undefined) updates.bio = p.bio;
        if (p?.expertise !== undefined) updates.expertise = p.expertise;
        if (p?.hobbies !== undefined) updates.hobbies = p.hobbies;
        await db.update(schema.userProfiles).set(updates)
          .where(eq(schema.userProfiles.userId, userId));
      }

      const rows = await db.select().from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId)).limit(1);
      return rows[0];
    }
    case "update_privacy": {
      const privacy = p?.privacy as Record<string, boolean> | undefined;
      if (!privacy) throw AppError.badRequest("privacy object is required");
      const now = new Date();

      const existing = await db.select({ userId: schema.userProfiles.userId })
        .from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);

      if (existing.length === 0) {
        await db.insert(schema.userProfiles).values({
          userId, privacy, createdAt: now, updatedAt: now,
        });
      } else {
        await db.update(schema.userProfiles).set({ privacy, updatedAt: now })
          .where(eq(schema.userProfiles.userId, userId));
      }
      return { ok: true };
    }
    case "list_optouts": {
      const rows = await db.select().from(schema.userDataOptouts)
        .where(eq(schema.userDataOptouts.userId, userId));
      return rows.map((r) => ({
        serviceId: r.serviceId, categoryKey: r.categoryKey,
        optedOutAt: r.optedOutAt.toISOString(),
      }));
    }
    case "optout": {
      const serviceId = requireStr(p, "serviceId");
      const categoryKey = requireStr(p, "categoryKey");
      await db.insert(schema.userDataOptouts).values({
        userId, serviceId, categoryKey, optedOutAt: new Date(),
      }).onConflictDoNothing();
      return { ok: true };
    }
    case "remove_optout": {
      const serviceId = requireStr(p, "serviceId");
      const categoryKey = requireStr(p, "categoryKey");
      await db.delete(schema.userDataOptouts).where(and(
        eq(schema.userDataOptouts.userId, userId),
        eq(schema.userDataOptouts.serviceId, serviceId),
        eq(schema.userDataOptouts.categoryKey, categoryKey),
      ));
      return { ok: true };
    }
    default:
      throw AppError.badRequest(`Unknown profile action: ${action}`);
  }
}

// -- ManagedProject (WS session only) --

async function managedProjectCmd(userId: string, action: string, p?: Record<string, unknown>): Promise<unknown> {
  const svc = await import("./project/service.js");

  switch (action) {
    case "list":
      return svc.listProjects();
    case "get":
      return svc.getProject(requireStr(p, "key"));
    case "templates":
      return svc.listServiceTemplates();
    case "get_template":
      return svc.getServiceTemplate(requireStr(p, "key"));
    case "register": {
      await requireSystemAdmin(userId);
      return svc.registerProject(p, userId);
    }
    case "delete": {
      await requireSystemAdmin(userId);
      return svc.deleteProject(requireStr(p, "key"));
    }
    case "update_schema": {
      await requireSystemAdmin(userId);
      return svc.updateProjectSchema(requireStr(p, "key"), p, userId);
    }
    case "definition_history":
      return svc.getDefinitionHistory(requireStr(p, "key"));
    case "list_optouts":
      return svc.listModuleOptouts(userId, requireStr(p, "projectKey"));
    case "optout": {
      return svc.setModuleOptout(userId, requireStr(p, "projectKey"), requireStr(p, "moduleKey"));
    }
    case "remove_optout": {
      return svc.removeModuleOptout(userId, requireStr(p, "projectKey"), requireStr(p, "moduleKey"));
    }
    case "my_data":
      return svc.getUserProjectData(userId, requireStr(p, "projectKey"));
    case "my_data_all":
      return svc.listAllUserProjectData(userId);
    default:
      throw AppError.badRequest(`Unknown managed_project action: ${action}`);
  }
}

// -- Helpers --

function requireStr(p: Record<string, unknown> | undefined, key: string): string {
  const v = p?.[key];
  if (typeof v !== "string" || !v) throw AppError.badRequest(`${key} is required`);
  return v;
}

function optStr(p: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = p?.[key];
  return typeof v === "string" ? v : undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function requireSystemAdmin(userId: string): Promise<void> {
  const rows = await db.select({ role: schema.users.role })
    .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (rows[0]?.role !== "admin") throw AppError.forbidden("System admin required");
}

async function requireOrgRole(userId: string, orgId: string, allowed: string[]): Promise<void> {
  const rows = await db.select({ role: schema.organizationMembers.role })
    .from(schema.organizationMembers)
    .where(and(
      eq(schema.organizationMembers.organizationId, orgId),
      eq(schema.organizationMembers.userId, userId),
    )).limit(1);
  if (rows.length === 0 || !allowed.includes(rows[0].role)) {
    throw AppError.forbidden("Insufficient organization permissions");
  }
}
