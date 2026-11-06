import { createHash, randomBytes } from "node:crypto";
import { localIdentity } from "./identity.js";
import { serviceOrigin } from "./origin.js";

export interface NativeCompositeOptions {
  cernereUrl: string;
  serviceUrl: string;
  clientId: string;
  identityDirectory?: string;
  signal?: AbortSignal;
}
export class NativeServiceError extends Error {
  constructor(readonly status: number) { super("Service request failed (" + status + ")"); }
}

/** The host holds one service's opaque session; Cr credentials never enter it. @implements SPEC-CR-NATIVE-COMPOSITE */
export class NativeComposite {
  readonly origin: string;
  readonly serviceUrl: string;
  private pending?: { verifier: string; state: string; createdAt: number };
  private token = "";
  private expiresAt = 0;
  private authenticating = false;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly abort = (): void => this.dispose();
  constructor(private readonly options: NativeCompositeOptions) {
    this.origin = serviceOrigin(options.cernereUrl);
    this.serviceUrl = serviceOrigin(options.serviceUrl);
    if (!options.clientId) throw new Error("The service's registered clientId is required");
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.dispose();
  }
  get hasSession(): boolean { return !this.disposed && !!this.token && this.expiresAt > Date.now(); }
  identity(): Promise<string> { return localIdentity(this.options.identityDirectory); }
  loginUrl(callerOrigin: string): string {
    if (this.disposed || this.authenticating) throw new Error("Native composite is closed or exchanging a code");
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const url = new URL("/composite/login", this.origin);
    url.searchParams.set("origin", serviceOrigin(callerOrigin));
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier, "ascii").digest("base64url"));
    url.searchParams.set("state", state);
    this.pending = { verifier, state, createdAt: Date.now() };
    return url.toString();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.disposed) throw new Error("Native composite is closed"); return operation(); });
    this.queue = next.catch(() => { /* The caller owns error reporting. */ });
    return next;
  }
  exchange(code: string, state: string): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.state !== state || Date.now() - pending.createdAt > 120_000 || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
      return Promise.reject(new Error("Invalid or expired native login response"));
    }
    if (this.authenticating) return Promise.reject(new Error("A native exchange is already pending"));
    this.authenticating = true;
    return this.serial(async () => {
      this.clear();
      await this.identity();
      const response = await fetch(this.serviceUrl + "/api/auth/native/exchange", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: pending.verifier }), redirect: "error", signal: this.signal(),
      });
      if (!response.ok) throw new NativeServiceError(response.status);
      const value = await response.json() as { sessionToken?: unknown; expiresAt?: unknown; accessToken?: unknown; refreshToken?: unknown; projectToken?: unknown };
      const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
      if (typeof value.sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.sessionToken)
        || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 900_000
        || value.accessToken !== undefined || value.refreshToken !== undefined || value.projectToken !== undefined) throw new Error("Invalid service session response");
      if (this.disposed) throw new Error("Native composite is closed");
      this.token = value.sessionToken;
      this.expiresAt = expiresAt;
    }).finally(() => { this.authenticating = false; });
  }
  private signal(timeout = 15_000): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, ...(this.options.signal ? [this.options.signal] : []), AbortSignal.timeout(timeout)]);
  }
  authorized(url: string, method = "GET", body?: unknown, timeout = 15_000): Promise<unknown> {
    const target = new URL(url);
    if (target.username || target.password || target.origin !== this.serviceUrl) return Promise.reject(new Error("Unconfigured service destination"));
    return this.serial(async () => {
      if (!this.hasSession) throw new Error("Service session expired; sign in again");
      const response = await fetch(target, {
        method, headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: this.signal(timeout),
      });
      if (response.status === 401) this.clear();
      if (!response.ok) throw new NativeServiceError(response.status);
      return response.status === 204 ? undefined : response.json();
    });
  }
  logout(): Promise<void> {
    return this.serial(async () => {
      const token = this.token;
      this.clear();
      if (!token) return;
      const response = await fetch(this.serviceUrl + "/api/auth/native/logout", {
        method: "POST", headers: { authorization: "Bearer " + token }, redirect: "error", signal: this.signal(),
      });
      if (!response.ok) throw new NativeServiceError(response.status);
    });
  }
  private clear(): void { this.token = ""; this.expiresAt = 0; }
  dispose(): void { this.disposed = true; this.lifetime.abort(); this.clear(); this.pending = undefined; this.options.signal?.removeEventListener("abort", this.abort); }
}
