/**
 * 「パスキーで続ける」1 つの入口で、ログインに失敗したときに作成へ進むかを決める (SPEC-PASSKEY-CONTINUE)。
 *
 * - 利用者が自分で押した ceremony が取消 / 候補なしで終わったときだけ作成へ進む。
 *   作成は認証器の「パスキーを作成」ダイアログを開くだけで、アカウントは利用者がそこで
 *   作成を完了したとき (signup-finish) に初めてできる。押しただけでは作らない (neco 2026-10-15)。
 * - 画面を開いた直後の自動起動が取消で終わっても作成へは進まない (開いただけで作成ダイアログを出さない)。
 * - 作成の導線が無い埋め込み先では従来どおり再試行の案内に戻る。
 */

export type PasskeyAbortOutcome = "create" | "fallback";

export function passkeyAbortOutcome(args: { manual: boolean; canCreate: boolean }): PasskeyAbortOutcome {
  return args.manual && args.canCreate ? "create" : "fallback";
}
