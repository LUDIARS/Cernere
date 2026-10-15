import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:04c299ca */
import augurContract_87bea62f from './contracts/return-target.contract.js'; /* augur-inject:contract-predicate:20480d56 */
/**
 * オンボーディングの戻り先 (Cernere 内パス) から、ログイン先サービスの target を取り出す (設計書 §4.2)。
 *
 *   /composite/login?origin=<サービスの origin>     → origin
 *   ...?redirect_uri=<サービスのコールバック URL>    → redirect_uri
 *
 * 外部 URL・プロトコル相対 (//host)・バックスラッシュ始まりは受け付けない。
 * 取り出した値は resolveSubjectByOrigin (consent/project-resolver.ts) と同じ規則でサービスに解決する。
 */

const INTERNAL_BASE = "https://cernere.internal";

/** 契約 C-30 (server/src/signup-fields/contracts/return-target.contract.ts) は augur inject が包む。 */
export function returnTargetOf(returnTo: unknown): string | null {
  if (typeof returnTo !== "string" || returnTo.length > 4096) return null;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.startsWith("/\\")) return null;
  let url: URL;
  try { url = new URL(returnTo, INTERNAL_BASE); } catch { return null; }
  if (url.origin !== INTERNAL_BASE) return null;
  const origin = url.pathname === "/composite/login" ? url.searchParams.get("origin") : null;
  return origin || url.searchParams.get("redirect_uri") || null;
}
// @ts-expect-error augur-inject
returnTargetOf = contract(returnTargetOf, { ...augurContract_87bea62f, contractId: 'C-30', mode: 'observe', sample: 1, where: 'server/src/signup-fields/return-target.ts:14', rule: 'contract-wrap', id: '87bea62f' }); /* augur-inject:contract-wrap:87bea62f */
