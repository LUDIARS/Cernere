/** Optional delivery boundary for operator CLIs; WS callers retain their existing response. */
export interface ProjectCredentials {
  key: string;
  clientId: string;
  clientSecret: string;
}

export type DeliverProjectCredentials = (credentials: ProjectCredentials) => Promise<void>;
