/** Public administration contract; no client secrets or raw Cloudflare subjects. */
export interface ConnectionSettings {
  projectKey: string; organizationId: string; oidcClientId: string; teamDomain: string; audience: string;
  requireMfa: boolean; maxAuthenticationAge: number; maxSessionSeconds: number; isActive: boolean;
}
export interface EnterpriseConnection extends ConnectionSettings { revision: string }
export interface EnterpriseConfiguration {
  connections: EnterpriseConnection[];
  identities: Array<{ projectKey: string; userId: string; isActive: boolean }>;
  organizations: Array<{ id: string; name: string }>;
  projects: Array<{ key: string; name: string; isActive: boolean }>;
  clients: Array<{ clientId: string; name: string; redirectUris: string[]; isActive: boolean }>;
  members: Array<{ organizationId: string; userId: string; name: string; role: string }>;
}
export type EnterpriseMutation = (action: string, payload: Record<string, unknown>) => Promise<void>;
