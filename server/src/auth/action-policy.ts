import { z } from "zod";

import { AppError } from "../error.js";

export const ACTION_AUTH_TTL_SECONDS = 5 * 60;

export const protectedActionSchema = z.enum([
  "passkey.register",
  "passkey.delete",
  "passkey.device_link",
  "organization.delete",
  "member.remove",
  "member.update_role",
  "project_definition.delete",
  "org_project.disable",
  "user.delete_account",
  "managed_project.delete",
  "managed_project.update_schema",
  "managed_project.rotate_secret",
  "oidc_client.rotate_secret",
  "oidc_client.update_redirect_uris",
  "oidc_client.disable",
]);

export type ProtectedAction = z.infer<typeof protectedActionSchema>;

export interface ActionTarget {
  action: ProtectedAction;
  resource: string;
}

export const actionTargetSchema = z.object({
  action: protectedActionSchema,
  resource: z.string().trim().min(1).max(512),
}).strict();

const protectedWsActions = new Set<ProtectedAction>([
  "organization.delete",
  "member.remove",
  "member.update_role",
  "project_definition.delete",
  "org_project.disable",
  "user.delete_account",
  "managed_project.delete",
  "managed_project.update_schema",
  "managed_project.rotate_secret",
  "oidc_client.rotate_secret",
  "oidc_client.update_redirect_uris",
  "oidc_client.disable",
]);

export function resolveWsActionTarget(
  userId: string,
  module: string,
  actionName: string,
  payload: unknown,
): ActionTarget | null {
  const action = `${module}.${actionName}`;
  const parsedAction = protectedActionSchema.safeParse(action);
  if (!parsedAction.success || !protectedWsActions.has(parsedAction.data)) return null;

  const p = asObject(payload);
  switch (parsedAction.data) {
    case "organization.delete":
      return target(parsedAction.data, requiredString(p, "organizationId"));
    case "member.remove":
    case "member.update_role":
      return target(parsedAction.data, joinResource(p, "organizationId", "userId"));
    case "project_definition.delete":
      return target(parsedAction.data, requiredString(p, "id"));
    case "org_project.disable":
      return target(parsedAction.data, joinResource(p, "organizationId", "projectDefinitionId"));
    case "user.delete_account":
      return target(parsedAction.data, optionalString(p, "userId") ?? userId);
    case "managed_project.delete":
    case "managed_project.update_schema":
    case "managed_project.rotate_secret":
      return target(parsedAction.data, requiredString(p, "key"));
    case "oidc_client.rotate_secret":
    case "oidc_client.update_redirect_uris":
    case "oidc_client.disable":
      return target(parsedAction.data, requiredString(p, "clientId"));
    default:
      return null;
  }
}

function target(action: ProtectedAction, resource: string): ActionTarget {
  return actionTargetSchema.parse({ action, resource });
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AppError.badRequest("Action payload must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw AppError.badRequest(`${key} is required`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinResource(payload: Record<string, unknown>, ...keys: string[]): string {
  return keys.map((key) => requiredString(payload, key)).join(":");
}
