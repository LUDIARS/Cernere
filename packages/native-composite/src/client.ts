import { localIdentity } from "./identity.js";
import { serviceOrigin } from "./origin.js";
import { NativeConnection } from "./connection.js";

export interface NativeCompositeOptions {
  cernereUrl: string;
  allowedServiceOrigins: readonly string[];
  identityDirectory?: string;
  signal?: AbortSignal;
}
export class NativeServiceError extends Error {
  constructor(readonly status: number) { super("Service request failed (" + status + ")"); }
}

/** Desktop-side bridge. Tokens stay in memory and never reach the renderer or plugins. */
export class NativeComposite {
  readonly origin: string;
  private readonly destinations: Set<string>;
  private readonly connection = new NativeConnection();
  private token = "";
  private refreshToken = "";
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly abort = (): void => this.dispose();
  constructor(private readonly options: NativeCompositeOptions) {
    this.origin = serviceOrigin(options.cernereUrl);
    this.destinations = new Set([this.origin, ...options.allowedServiceOrigins.map(serviceOrigin)]);
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.dispose();
  }
  get connected(): boolean { return this.connection.connected; }
  identity(): Promise<string> { return localIdentity(this.options.identityDirectory); }
  loginUrl(callerOrigin: string): string {
    const url = new URL("/composite/login", this.origin);
    url.searchParams.set("origin", serviceOrigin(callerOrigin));
    return url.toString();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.disposed) throw new Error("Native composite is closed"); return operation(); });
    this.queue = next.catch(() => { /* The caller owns error reporting. */ });
    return next;
  }
  private async authenticate(path: string, body: unknown): Promise<void> {
    const response = await fetch(this.origin + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      redirect: "error", signal: this.signal(),
    });
    if (!response.ok) throw new NativeServiceError(response.status);
    const value = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
    if (typeof value.accessToken !== "string" || !value.accessToken || typeof value.refreshToken !== "string" || !value.refreshToken) throw new Error("Invalid Cernere session response");
    if (this.disposed) throw new Error("Native composite is closed");
    this.token = value.accessToken;
    this.refreshToken = value.refreshToken;
    await this.connection.connect(this.origin, this.token);
    if (this.disposed) { this.connection.close(); throw new Error("Native composite is closed"); }
  }
  exchange(code: string): Promise<void> {
    if (!code || code.length > 4096) return Promise.reject(new Error("An authorization code is required"));
    return this.serial(async () => { this.clear(); await this.identity(); await this.authenticate("/api/auth/exchange", { code }); });
  }
  private signal(timeout = 15_000): AbortSignal {
    return this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  }
  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new Error("Sign in with Cernere first");
    try { await this.authenticate("/api/auth/refresh", { refreshToken: this.refreshToken }); }
    catch (error) { this.clear(); throw error; }
  }
  authorized(url: string, method = "GET", body?: unknown, timeout = 15_000): Promise<unknown> {
    const target = new URL(url);
    if (target.username || target.password || !this.destinations.has(target.origin)) return Promise.reject(new Error("Unconfigured service destination"));
    return this.serial(async () => {
      if (!this.connection.connected) await this.refresh();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(target, {
          method, headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: this.signal(timeout),
        });
        if (response.status === 401 && attempt === 0) { await this.refresh(); continue; }
        if (!response.ok) throw new NativeServiceError(response.status);
        return response.status === 204 ? undefined : response.json();
      }
      throw new Error("Cernere session expired");
    });
  }
  logout(): Promise<void> {
    return this.serial(async () => {
      const refreshToken = this.refreshToken;
      this.clear();
      if (!refreshToken) return;
      const response = await fetch(this.origin + "/api/auth/logout", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }),
        redirect: "error", signal: this.signal(),
      });
      if (!response.ok) throw new NativeServiceError(response.status);
    });
  }
  private clear(): void { this.connection.close(); this.token = ""; this.refreshToken = ""; }
  dispose(): void { this.disposed = true; this.clear(); this.options.signal?.removeEventListener("abort", this.abort); }
}
