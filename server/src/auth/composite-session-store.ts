import { AppError } from "../error.js";

/** Atomic persistence operations; the policy layer cannot supply executable scripts. */
export interface CompositeSessionCommands {
  createIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  read(key: string): Promise<string | null>;
  compareAndRevoke(key: string, active: string, revoked: string): Promise<boolean>;
}

/** One grant has one service session until expiry, including after logout. @implements SPEC-COMPOSITE-OPERATION-GUARD */
export class CompositeSessionStore {
  constructor(private readonly commands: CompositeSessionCommands) {}
  private key(grantId: string): string { return `composite-session:${grantId}`; }
  async bind(grantId: string, sessionBinding: string, ttlSeconds: number): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw AppError.unauthorized("Service session expired");
    const value = `active:${sessionBinding}`;
    const created = await this.commands.createIfAbsent(this.key(grantId), value, ttlSeconds);
    if (!created && await this.commands.read(this.key(grantId)) !== value) throw AppError.unauthorized("Service session is already bound or revoked");
  }
  async requireBound(grantId: string, sessionBinding: string): Promise<void> {
    if (await this.commands.read(this.key(grantId)) !== `active:${sessionBinding}`) throw AppError.unauthorized("Service session is not active");
  }
  async revoke(grantId: string, sessionBinding: string): Promise<void> {
    if (!await this.commands.compareAndRevoke(this.key(grantId), `active:${sessionBinding}`, `revoked:${sessionBinding}`)) throw AppError.unauthorized("Service session is not active");
  }
}
