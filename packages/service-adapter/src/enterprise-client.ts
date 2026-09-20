/** Project-scoped enterprise sessions; every protected operation asks Cr for current authorization. */
export interface EnterpriseSessionInfo {
  userId: string; projectKey: string; organizationId: string; organizationRole: string;
  authTime: number; amr: string[]; expiresAt: number;
}
export interface EnterpriseLoginResult { enterpriseToken: string; session: EnterpriseSessionInfo }
/** Supply the service's authenticated /ws/project command transport, never a browser-selected project. */
export type EnterpriseRequest = (module: "enterprise", action: string, payload: Record<string, unknown>) => Promise<unknown>;

export class EnterpriseSessionClient {
  constructor(private readonly projectKey: string, private readonly request: EnterpriseRequest) {
    if (!projectKey) throw new Error("Enterprise project key is required");
  }

  async login(assertion: string): Promise<EnterpriseLoginResult> {
    if (!assertion || assertion.length > 16384) throw new Error("Cloudflare assertion is required");
    return this.loginResult(await this.command("login", { assertion }));
  }

  async verify(enterpriseToken: string): Promise<EnterpriseSessionInfo> {
    requireToken(enterpriseToken);
    return this.session(await this.command("verify", { enterpriseToken }));
  }

  async refresh(enterpriseToken: string): Promise<EnterpriseLoginResult> {
    requireToken(enterpriseToken);
    return this.loginResult(await this.command("refresh", { enterpriseToken }));
  }

  async logout(enterpriseToken: string): Promise<void> {
    requireToken(enterpriseToken);
    await this.command("logout", { enterpriseToken });
  }

  /** Forward a trusted offboarding event; the project credential limits this to this service. */
  async revokeUser(userId: string): Promise<void> {
    if (!userId) throw new Error("User ID is required");
    await this.command("revoke_user", { userId });
  }

  /** Validate before upgrade, close the downstream WS on revocation/unavailability, dispose on its close. */
  async watch(enterpriseToken: string, onRevoked: () => void, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Enterprise watch cancelled");
    const initial = await this.verify(enterpriseToken);
    if (signal?.aborted) throw new Error("Enterprise watch cancelled");
    let stopped = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    const expiry = setTimeout(revoke, Math.max(0, initial.expiresAt * 1000 - Date.now()));
    function stop(): void { stopped = true; clearTimeout(expiry); if (next) clearTimeout(next); signal?.removeEventListener("abort", stop); }
    function revoke(): void { if (stopped) return; stop(); onRevoked(); }
    const poll = async (): Promise<void> => {
      try {
        await this.verify(enterpriseToken);
        if (!stopped) next = setTimeout(() => { void poll(); }, 15000);
      } catch { revoke(); }
    };
    next = setTimeout(() => { void poll(); }, 15000);
    signal?.addEventListener("abort", stop, { once: true });
    return stop;
  }

  private async command(action: string, payload: Record<string, unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.request("enterprise", action, payload), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Enterprise authorization unavailable")), 10000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private loginResult(value: unknown): EnterpriseLoginResult {
    const result = object(value);
    const token = typeof result.enterpriseToken === "string" ? result.enterpriseToken : "";
    requireToken(token);
    return { enterpriseToken: token, session: this.session(result.session) };
  }

  private session(value: unknown): EnterpriseSessionInfo {
    const result = object(value);
    if (result.projectKey !== this.projectKey || typeof result.userId !== "string" || !result.userId
      || typeof result.organizationId !== "string" || !result.organizationId
      || typeof result.organizationRole !== "string" || !result.organizationRole
      || !Number.isSafeInteger(result.authTime) || !Array.isArray(result.amr) || !result.amr.every((item) => typeof item === "string")
      || !Number.isSafeInteger(result.expiresAt) || Number(result.expiresAt) * 1000 <= Date.now()) {
      throw new Error("Enterprise session is invalid or expired");
    }
    return result as unknown as EnterpriseSessionInfo;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid enterprise response");
  return value as Record<string, unknown>;
}
function requireToken(value: string): void {
  if (!/^ces_[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Enterprise session token is required");
}
