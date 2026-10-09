export interface WorkloadPrincipal {
  id: string;
  clientId: string;
  clientSecretHash: string;
  revokedAt: Date | null;
}
export interface WorkloadKey {
  id: string;
  subject: string;
  publicKeyPem: string;
  revokedAt: Date | null;
}
export interface WorkloadGrant {
  id: string;
  subject: string;
  audience: string;
  action: string;
  resource: string;
  keys: string[] | null;
  revokedAt: Date | null;
}
export interface WorkloadToken {
  id: string;
  tokenHash: string;
  subject: string;
  audience: string;
  keyId: string;
  grantId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface WorkloadSnapshot {
  subject: WorkloadPrincipal;
  target: WorkloadPrincipal;
  key: WorkloadKey;
  targetKey: WorkloadKey;
  grant: WorkloadGrant;
  token: WorkloadToken;
}
export interface WorkloadClaims {
  kind: 'workload'; sub: string; aud: string; iat: string; exp: string; jti: string;
  cnf: { public_key: string };
  grants: { action: string; resource: string; keys?: string[] }[];
}
export interface WorkloadStore {
  principal(clientId: string): Promise<WorkloadPrincipal | null>;
  authority(subject: string, audience: string, action: string, resource: string): Promise<Omit<WorkloadSnapshot, 'token'> | null>;
  saveToken(token: WorkloadToken): Promise<void>;
  snapshot(tokenHash: string): Promise<WorkloadSnapshot | null>;
}
