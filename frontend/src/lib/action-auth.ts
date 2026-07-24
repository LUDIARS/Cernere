import { startAuthentication } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type ProtectedAction =
  | "passkey.register"
  | "passkey.delete"
  | "passkey.device_link"
  | "organization.delete"
  | "member.remove"
  | "member.update_role"
  | "project_definition.delete"
  | "org_project.disable"
  | "user.delete_account"
  | "managed_project.delete"
  | "managed_project.update_schema"
  | "managed_project.rotate_secret"
  | "oidc_client.rotate_secret"
  | "oidc_client.update_redirect_uris"
  | "oidc_client.disable";

interface ActionAuthBegin {
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export async function authorizeAction(
  action: ProtectedAction,
  resource: string,
  sessionId?: string,
): Promise<string> {
  const begin = await actionRequest<ActionAuthBegin>("begin", {
    action,
    resource,
    ...(sessionId ? { sessionId } : {}),
  });
  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: begin.options,
  });
  const finish = await actionRequest<{ proof: string }>("finish", {
    ceremonyId: begin.ceremonyId,
    response,
  });
  return finish.proof;
}

export function resolveBrowserActionTarget(
  module: string,
  action: string,
  payload: unknown,
  currentUserId: string | undefined,
): { action: ProtectedAction; resource: string } | null {
  const name = `${module}.${action}` as ProtectedAction;
  const p = asObject(payload);
  switch (name) {
    case "organization.delete":
      return { action: name, resource: requiredString(p, "organizationId") };
    case "member.remove":
    case "member.update_role":
      return { action: name, resource: joinResource(p, "organizationId", "userId") };
    case "project_definition.delete":
      return { action: name, resource: requiredString(p, "id") };
    case "org_project.disable":
      return { action: name, resource: joinResource(p, "organizationId", "projectDefinitionId") };
    case "user.delete_account":
      return { action: name, resource: optionalString(p, "userId") ?? requireCurrentUser(currentUserId) };
    case "managed_project.delete":
    case "managed_project.update_schema":
    case "managed_project.rotate_secret":
      return { action: name, resource: requiredString(p, "key") };
    case "oidc_client.rotate_secret":
    case "oidc_client.update_redirect_uris":
    case "oidc_client.disable":
      return { action: name, resource: requiredString(p, "clientId") };
    default:
      return null;
  }
}

async function actionRequest<T>(phase: "begin" | "finish", body: unknown): Promise<T> {
  let token = localStorage.getItem("accessToken");
  if (!token) throw new Error("ログインセッションがありません。再度ログインしてください。");
  const makeRequest = (accessToken: string) => fetch(`${API_BASE}/api/auth/action/${phase}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let response = await makeRequest(token);
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (token) response = await makeRequest(token);
  }
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Action authentication failed");
  return data;
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) return null;
  const response = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) return null;
  const tokens = await response.json() as { accessToken: string; refreshToken: string };
  localStorage.setItem("accessToken", tokens.accessToken);
  localStorage.setItem("refreshToken", tokens.refreshToken);
  return tokens.accessToken;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinResource(payload: Record<string, unknown>, ...keys: string[]): string {
  return keys.map((key) => requiredString(payload, key)).join(":");
}

function requireCurrentUser(userId: string | undefined): string {
  if (!userId) throw new Error("Current user is unavailable");
  return userId;
}
