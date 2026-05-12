/**
 * env-bootstrap — `.env` ファイル無しで Cernere を起動するための env 注入。
 *
 * 起動順:
 *   1. Excubitor 経由で起動: 親が catalog.infisical.inject=true で全 secret を子プロセス
 *      env に直接渡している。 本モジュールは「もう揃っている」のを検知して即 return。
 *   2. 単独起動: ホストの shell で `INFISICAL_CLIENT_ID` と `INFISICAL_CLIENT_SECRET`
 *      (および `INFISICAL_SITE_URL` / `INFISICAL_PROJECT_ID` / `INFISICAL_ENVIRONMENT`) を
 *      渡すと、 起動時に Infisical universal-auth → secrets/raw を fetch して
 *      `process.env` に注入する。 `.env` ファイルは一切読まない。
 *
 * Cernere の任意の module (config.ts 等) が import される **前** に `ensureEnv()` を
 * await すること。 `bootstrap.ts` を entry にする運用が前提。
 */

// 「あれば既に揃ってる」と見なす key の集合。 ここがすべて埋まっていれば fetch 不要。
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_REDIRECT_URI',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'FRONTEND_URL',
] as const;

export async function ensureEnv(): Promise<void> {
  const missing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (missing.length === 0) {
    console.log('[env-bootstrap] all required env already set (Excubitor inject / host env)');
    return;
  }

  const siteUrl = process.env.INFISICAL_SITE_URL?.replace(/\/$/, '');
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const environment = process.env.INFISICAL_ENVIRONMENT ?? 'dev';
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;

  if (!siteUrl || !projectId || !clientId || !clientSecret) {
    throw new Error(
      `[env-bootstrap] missing env: ${missing.join(', ')}\n` +
        `Pass either:\n` +
        `  (A) Run via Excubitor with catalog.infisical.inject=true (preferred)\n` +
        `  (B) Provide INFISICAL_SITE_URL / INFISICAL_PROJECT_ID / INFISICAL_ENVIRONMENT / INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET via host env`,
    );
  }

  console.log(`[env-bootstrap] missing ${missing.length} keys — fetching from Infisical (${siteUrl}, env=${environment})`);

  // universal-auth login
  const loginRes = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!loginRes.ok) {
    throw new Error(`[env-bootstrap] Infisical login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { accessToken } = (await loginRes.json()) as { accessToken: string };

  // secrets/raw
  const params = new URLSearchParams({ workspaceId: projectId, environment, secretPath: '/' });
  const secretsRes = await fetch(`${siteUrl}/api/v3/secrets/raw?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!secretsRes.ok) {
    throw new Error(`[env-bootstrap] Infisical secrets failed: ${secretsRes.status} ${await secretsRes.text()}`);
  }
  const { secrets } = (await secretsRes.json()) as { secrets: Array<{ secretKey: string; secretValue: string }> };

  let injected = 0;
  for (const s of secrets) {
    if (!process.env[s.secretKey]) {
      process.env[s.secretKey] = s.secretValue;
      injected++;
    }
  }
  console.log(`[env-bootstrap] injected ${injected} secrets from Infisical (${secrets.length} available)`);

  const stillMissing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (stillMissing.length > 0) {
    throw new Error(`[env-bootstrap] still missing after Infisical fetch: ${stillMissing.join(', ')}`);
  }
}
