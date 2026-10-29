/**
 * サービスの資格情報 (client_id + client_secret) で token を取る入口のレート制限。
 *
 * 秘密を確かめる前に client_id 単位で数えると、client_id を知る第三者が失敗要求を送るだけで
 * 本物のサービスを締め出せる。ここでは次の 2 つに分ける。
 *   - 確かめる前: 接続元 (rateLimitSubject) 単位で全要求を数える
 *   - 確かめた後: 「client_id × 接続元」の失敗回数だけを数え、超えたら拒否する (成功は数えない)
 * 外からの失敗は、その接続元の枠しか使い切れない。
 */
import { checkRateLimit, isRateLimited, recordRateLimitHit } from "../redis.js";
import { rateLimitSubject } from "../http/rate-limit-subject.js";

export type CredentialEndpoint = "project_login" | "service_token" | "project_launch_credential";

const WINDOW_SECS = 300;
/** 1 接続元からの全要求 (成功を含む)。サービスは数分に数回しか取らないので余裕を持たせる。 */
const PER_SOURCE = 120;
/** 1 接続元から 1 client_id への失敗。 */
const FAILURES_PER_CLIENT_AND_SOURCE = 10;

const failureKey = (endpoint: CredentialEndpoint, clientId: string, ip: string | undefined) =>
  `${endpoint}:fail:${clientId}:${rateLimitSubject(ip)}`;

/** 秘密を確かめる前に呼ぶ。接続元の枠を 1 つ使い、失敗が溜まった組み合わせなら拒否する。 */
export async function beforeCredentialCheck(
  endpoint: CredentialEndpoint, clientId: string, ip: string | undefined,
): Promise<void> {
  await checkRateLimit(`${endpoint}:src:${rateLimitSubject(ip)}`, PER_SOURCE, WINDOW_SECS);
  if (await isRateLimited(failureKey(endpoint, clientId, ip), FAILURES_PER_CLIENT_AND_SOURCE)) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }
}

/** 資格情報が合わなかったときだけ呼ぶ。 */
export async function recordCredentialFailure(
  endpoint: CredentialEndpoint, clientId: string, ip: string | undefined,
): Promise<void> {
  await recordRateLimitHit(failureKey(endpoint, clientId, ip), WINDOW_SECS);
}
