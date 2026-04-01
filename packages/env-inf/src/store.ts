/**
 * グローバル環境変数ストア
 * process.env とは独立した環境変数パラメータ領域
 */

import type { EnvReader } from "./types.js";

export class EnvStore implements EnvReader {
  private readonly params = new Map<string, string>();

  get(key: string): string | undefined {
    return this.params.get(key);
  }

  getAll(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.params);
  }

  has(key: string): boolean {
    return this.params.has(key);
  }

  keys(): string[] {
    return [...this.params.keys()];
  }

  /** 単一キーを設定 */
  set(key: string, value: string): void {
    this.params.set(key, value);
  }

  /** 複数キーを一括設定 (既存キーは上書き) */
  merge(entries: Record<string, string>): void {
    for (const [k, v] of Object.entries(entries)) {
      this.params.set(k, v);
    }
  }

  /** 全キーをクリア */
  clear(): void {
    this.params.clear();
  }
}
