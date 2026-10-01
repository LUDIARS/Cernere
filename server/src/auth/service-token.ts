/**
 * service 文脈の PASETO v4 token (auth-plane consolidation P2)。
 *
 * ユーザ不在の service 間呼び出し向け。 呼出元 service は自分の project client
 * credentials を Cernere にだけ提示し、 scope 付きの短命 token を得る。
 * 署名鍵・検証経路は user 版 (`user_for_project`) と同じで、 受け側は
 * `/.well-known/cernere-public-key` の公開鍵で検証する。
 *
 * claims の sub / aud / scope は Cernere の登録情報 (managed_projects) からのみ決まる。
 * 発行は project/service-token-issuer.ts、 署名と形の検証はここ。
 */

import { signPasetoClaims, verifyPasetoClaims } from "./paseto.js";

/**
 * service token の既定 TTL。 user 版 project-token (15 分) と揃えている。
 * 常駐 scheduler 向けに延ばすかは未決 (spec/feature/service-token.md「判断が要る点」)。
 */
export const SERVICE_TOKEN_TTL_SEC = 15 * 60;

export interface PasetoServiceClaims {
  kind: "service";
  /** 呼出元 project の不変識別子 (managed_projects.storage_slug)。 改名で変わらない。 */
  sub: string;
  /** 呼出先 project の不変識別子 (managed_projects.storage_slug)。 */
  aud: string;
  /** 呼出元の service_scopes 宣言から導出した許可済み操作 (重複なし・昇順)。 */
  scope: string[];
  iat: string;
  exp: string;
  jti: string;
}

export async function signServiceToken(params: {
  subject: string;
  audience: string;
  scopes: readonly string[];
  ttlSec?: number;
}): Promise<string> {
  const nowMs = Date.now();
  const ttlSec = params.ttlSec ?? SERVICE_TOKEN_TTL_SEC;
  const claims: PasetoServiceClaims = {
    kind: "service",
    sub: params.subject,
    aud: params.audience,
    scope: [...params.scopes],
    iat: new Date(nowMs).toISOString(),
    exp: new Date(nowMs + ttlSec * 1000).toISOString(),
    jti: crypto.randomUUID(),
  };
  return signPasetoClaims(claims as unknown as Record<string, unknown>);
}

/**
 * service token を検証する (受け側実装の参照用 + unit test 用)。
 * aud は受け側自身の識別子を必ず渡す。 kind / scope の形が崩れた token は拒否する。
 */
export async function verifyServiceTokenPaseto(
  token: string,
  expectedAudience: string,
): Promise<PasetoServiceClaims> {
  const payload = await verifyPasetoClaims(token, expectedAudience);
  if (payload.kind !== "service") {
    throw new Error(`PASETO verification failed: invalid token kind: ${String(payload.kind)}`);
  }
  if (typeof payload.sub !== "string" || !payload.sub
    || !Array.isArray(payload.scope) || !payload.scope.every((s) => typeof s === "string")) {
    throw new Error("PASETO verification failed: malformed service token claims");
  }
  return payload as unknown as PasetoServiceClaims;
}

/** 受け側の scope 照合。 token の呼出元名ではなく scope だけで判定する。 */
export function hasServiceScope(claims: Pick<PasetoServiceClaims, "scope">, required: string): boolean {
  return claims.scope.includes(required);
}
