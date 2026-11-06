/** Live project-owned Composite destination lookup. No global origin allow-list. */
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { managedProjects } from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { declaredCompositeOrigins, isCompositeOrigin, isOriginAllowed } from "../project/composite-origin-policy.js";
import { isPkceS256Challenge } from "../lib/crypto/pkce.js";
import type { AuthCodeBinding } from "./auth-code-store.js";
import { declaredServiceScopes } from "../project/service-scopes.js";

export async function compositeAllowedOrigins(): Promise<string[]> {
  const projects = await db.select({ key: managedProjects.key, definition: managedProjects.schemaDefinition })
    .from(managedProjects).where(eq(managedProjects.isActive, true));
  return [...new Set(projects.flatMap(project => declaredCompositeOrigins(project.definition, project.key, config.isDevelopment)))];
}

export async function projectCompositeTarget(clientId: string, target: string): Promise<typeof managedProjects.$inferSelect> {
  const project = (await db.select().from(managedProjects).where(eq(managedProjects.clientId, clientId)).limit(1))[0];
  if (!project?.isActive || !isOriginAllowed(target, declaredCompositeOrigins(project.schemaDefinition, project.key, config.isDevelopment))) {
    throw AppError.unauthorized("Invalid Composite destination");
  }
  return project;
}

export function registeredHubUrl(definition: unknown, projectKey: string): string {
  const value = definition && typeof definition === "object" ? (definition as { hub_url?: unknown }).hub_url : undefined;
  if (!isCompositeOrigin(value, projectKey, config.isDevelopment)) throw new Error("Composite hub_url is not registered");
  return value;
}

/** Trusted binding carried through passkey completion and consent tickets. */
export async function resolveAuthCodeBinding(
  input: Record<string, unknown>, context: { origin?: string; projectKey?: string },
): Promise<AuthCodeBinding> {
  const codeChallenge = input.code_challenge;
  if (!isPkceS256Challenge(codeChallenge)) throw AppError.badRequest("S256 code_challenge is required");
  const target = typeof input.target === "string" ? input.target : "";
  if (!target && !context.projectKey) {
    const ownOrigin = new URL(config.frontendUrl).origin;
    if (context.origin !== ownOrigin) throw AppError.unauthorized("Invalid Composite destination");
    return { audience: "cernere", origin: ownOrigin, codeChallenge };
  }
  const clientId = typeof input.client_id === "string" ? input.client_id : "";
  if (!clientId || !target) throw AppError.badRequest("client_id and target are required");
  const project = await projectCompositeTarget(clientId, target);
  if (context.projectKey && context.projectKey !== project.key) throw AppError.unauthorized("Invalid Composite destination");
  registeredHubUrl(project.schemaDefinition, project.key);
  if (input.code_audience === "kiosk") {
    if (!declaredServiceScopes(project.schemaDefinition).includes("auth-code:kiosk-exchange")) throw AppError.unauthorized("Invalid Composite destination");
    return { audience: "kiosk", projectKey: project.key };
  }
  if (input.code_audience !== undefined && input.code_audience !== "service") throw AppError.badRequest("Invalid authorization code audience");
  return { audience: "service", projectKey: project.key, origin: new URL(target).origin, codeChallenge };
}
