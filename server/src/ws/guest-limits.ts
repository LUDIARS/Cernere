/**
 * 未認証ゲスト WS (/auth を資格情報なしで開いた接続) の上限。
 *
 * ゲストは MFA の確認コードを送るためだけにある。上限が無いと、資格情報なしで接続を張り続けるだけで
 * fd とメモリを使い切れる (2026-10-29 の点検)。接続元ごと・全体の同時接続数と、ゲストのままでいられる
 * 時間を持つ。数は 1 プロセスのメモリで数える (Cernere は 1 プロセスで動く)。
 */

export const GUEST_LIMITS = {
  /** 1 接続元から同時に張れるゲスト接続。 */
  perSource: 20,
  /** プロセス全体のゲスト接続。 */
  total: 2000,
  /** ゲストのままでいられる時間。MFA の確認コード入力に足りる長さ。 */
  lifetimeMs: 5 * 60 * 1000,
} as const;

export class GuestSlots {
  private readonly bySource = new Map<string, number>();
  private count = 0;

  constructor(private readonly limits: { perSource: number; total: number } = GUEST_LIMITS) {}

  /** 枠を 1 つ取る。取れなければ false (呼び出し側は upgrade を断る)。 */
  acquire(source: string): boolean {
    const current = this.bySource.get(source) ?? 0;
    if (this.count >= this.limits.total || current >= this.limits.perSource) return false;
    this.bySource.set(source, current + 1);
    this.count += 1;
    return true;
  }

  /** 枠を返す。ゲストが閉じたときと、ログインして昇格したときに 1 回だけ呼ぶ。 */
  release(source: string): void {
    const current = this.bySource.get(source) ?? 0;
    if (current <= 0) return;
    if (current === 1) this.bySource.delete(source);
    else this.bySource.set(source, current - 1);
    this.count -= 1;
  }

  get size(): number {
    return this.count;
  }
}

export const guestSlots = new GuestSlots();
