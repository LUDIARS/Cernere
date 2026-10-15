import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:4685f0c5 */
import augurContract_95a9033a from './contracts/continuation.contract.js'; /* augur-inject:contract-predicate:05949c0b */
/**
 * 同意完了後の継続先 (設計書 §4.2)。
 *
 * 継続先は consentTicket の発行時に検証した値だけを使い、/consent のクエリからは受け取らない
 * (open redirect 防止)。検証は「許可 origin への完全一致」で、許可 origin は composite の
 * 許可リストと対象サービスの frontend_url の origin。
 */


export type ConsentContinuation =
  /** popup: 親窓 (opener) へ postMessage で authCode / consent_denied を返す */
  | { kind: "post_message"; origin: string }
  /** 同一窓 / 新しいタブ: url へ遷移する (authCode は ?code=、拒否は ?error=consent_denied) */
  | { kind: "redirect"; url: string };

export interface ContinuationRequest {
  mode: "post_message" | "redirect";
  /** 呼び出し元が渡した送り先 (未検証)。post_message は origin、redirect は完全 URL */
  target: string;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** 契約 C-26 (server/src/consent/contracts/continuation.contract.ts) は augur inject が包む。 */
export function buildConsentContinuation(request: ContinuationRequest, allowedOrigins: readonly string[]): ConsentContinuation | null {
  const url = parseHttpUrl(request.target);
  if (!url || url.origin === "null" || !allowedOrigins.includes(url.origin)) return null;
  if (request.mode === "post_message") return { kind: "post_message", origin: url.origin };
  url.hash = "";
  return { kind: "redirect", url: url.toString() };
}
// @ts-expect-error augur-inject
buildConsentContinuation = contract(buildConsentContinuation, { ...augurContract_95a9033a, contractId: 'C-26', mode: 'observe', sample: 1, where: 'server/src/consent/continuation.ts:34', rule: 'contract-wrap', id: '95a9033a' }); /* augur-inject:contract-wrap:95a9033a */

/** origin を取り出す (許可リストの組み立て用)。不正な URL は null。 */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = parseHttpUrl(value);
  return url && url.origin !== "null" ? url.origin : null;
}

export type ContinuationOutcome =
  | { kind: "post_message"; origin: string; message: { type: "cernere:auth"; authCode?: string; error?: "consent_denied" } }
  | { kind: "redirect"; url: string }
  | { kind: "none" };

/** 同意 / 拒否の結果を継続先へ載せる。authCode が無い許可 (edge の再試行) は継続先へ戻すだけ。 */
export function completeContinuation(
  continuation: ConsentContinuation | null,
  result: { authCode: string } | { authCode: null } | { denied: true },
): ContinuationOutcome {
  if (!continuation) return { kind: "none" };
  const denied = "denied" in result;
  if (continuation.kind === "post_message") {
    return {
      kind: "post_message",
      origin: continuation.origin,
      message: denied ? { type: "cernere:auth", error: "consent_denied" }
        : result.authCode ? { type: "cernere:auth", authCode: result.authCode } : { type: "cernere:auth" },
    };
  }
  const url = new URL(continuation.url);
  if (denied) url.searchParams.set("error", "consent_denied");
  else if (result.authCode) url.searchParams.set("code", result.authCode);
  return { kind: "redirect", url: url.toString() };
}
