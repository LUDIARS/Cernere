/**
 * EnvInf — Infisical 環境変数プロバイダ
 *
 * - Infisical API からシークレットを取得し内部ストアに保持
 * - アプリ起動中のみ process.env へ展開
 * - getter インタフェースで都度取得にも対応
 */

import type { EnvInfOptions, EnvReader, EnvFetcher } from "./types.js";
import { InfisicalClient } from "./client.js";
import { EnvStore } from "./store.js";

export class EnvInf implements EnvReader, EnvFetcher {
  private readonly client: InfisicalClient;
  private readonly store: EnvStore;
  private readonly appliedKeys = new Set<string>();
  private readonly removeOnDispose: boolean;
  private disposed = false;

  private constructor(opts: EnvInfOptions) {
    this.client = new InfisicalClient(opts.connection);
    this.store = new EnvStore();
    this.removeOnDispose = opts.removeOnDispose ?? true;
  }

  /**
   * EnvInf を作成し、Infisical から初期ロードを行う
   */
  static async create(opts: EnvInfOptions): Promise<EnvInf> {
    const instance = new EnvInf(opts);
    await instance.fetchAll();
    if (opts.applyToProcessEnv !== false) {
      instance.applyToProcessEnv();
    }
    return instance;
  }

  // ─── EnvReader ──────────────────────────────────────────

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  getOrDefault(key: string, defaultValue: string): string {
    return this.store.getOrDefault(key, defaultValue);
  }

  getAll(): Readonly<Record<string, string>> {
    return this.store.getAll();
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return this.store.keys();
  }

  // ─── EnvFetcher ─────────────────────────────────────────

  async fetch(key: string): Promise<string | undefined> {
    this.ensureNotDisposed();
    const value = await this.client.fetchSecret(key);
    if (value !== undefined) {
      this.store.set(key, value);
      if (this.appliedKeys.size > 0) {
        process.env[key] = value;
        this.appliedKeys.add(key);
      }
    }
    return value;
  }

  async fetchAll(): Promise<Readonly<Record<string, string>>> {
    this.ensureNotDisposed();
    const secrets = await this.client.fetchSecrets();
    const entries: Record<string, string> = {};
    for (const s of secrets) {
      entries[s.secretKey] = s.secretValue;
    }
    this.store.merge(entries);
    if (this.appliedKeys.size > 0) {
      this.applyToProcessEnv();
    }
    return this.store.getAll();
  }

  // ─── process.env 操作 ───────────────────────────────────

  /**
   * ストアの全キーを process.env に展開
   */
  applyToProcessEnv(): void {
    const all = this.store.getAll();
    for (const [key, value] of Object.entries(all)) {
      process.env[key] = value;
      this.appliedKeys.add(key);
    }
  }

  /**
   * このインスタンスが展開したキーを process.env から除去
   */
  removeFromProcessEnv(): void {
    for (const key of this.appliedKeys) {
      delete process.env[key];
    }
    this.appliedKeys.clear();
  }

  // ─── ライフサイクル ─────────────────────────────────────

  /**
   * リソースを解放し process.env をクリーンアップ
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.removeOnDispose) {
      this.removeFromProcessEnv();
    }
    this.store.clear();
    this.client.invalidate();
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("EnvInf has been disposed");
    }
  }
}
