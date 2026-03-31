/**
 * Infisical REST API クライアント (ゼロ依存)
 */

import type {
  InfisicalBootstrap,
  AuthResponse,
  RawSecret,
  SecretsResponse,
} from "./types.js";

/**
 * Universal Auth でアクセストークンを取得
 */
export async function authenticate(config: InfisicalBootstrap): Promise<string> {
  const res = await fetch(
    `${config.siteUrl}/api/v1/auth/universal-auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Authentication failed: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as AuthResponse;
  return data.accessToken;
}

/**
 * 指定パスのシークレット一覧を取得
 */
export async function fetchSecrets(
  config: InfisicalBootstrap,
  token: string,
  secretPath = "/",
): Promise<RawSecret[]> {
  const params = new URLSearchParams({
    environment: config.environment,
    workspaceId: config.projectId,
    secretPath,
  });

  const res = await fetch(
    `${config.siteUrl}/api/v3/secrets/raw?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch secrets: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as SecretsResponse;
  return data.secrets;
}

/**
 * キー指定でシークレットを取得
 */
export async function getSecretByKey(
  config: InfisicalBootstrap,
  token: string,
  key: string,
  secretPath = "/",
): Promise<string | null> {
  const secrets = await fetchSecrets(config, token, secretPath);
  const found = secrets.find((s) => s.secretKey === key);
  return found ? found.secretValue : null;
}

/**
 * シークレットを作成 or 更新 (upsert)
 */
export async function upsertSecret(
  config: InfisicalBootstrap,
  token: string,
  key: string,
  value: string,
  secretPath = "/",
): Promise<void> {
  const url = `${config.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`;
  const body = {
    workspaceId: config.projectId,
    environment: config.environment,
    secretPath,
    secretValue: value,
    type: "shared",
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Try update first
  const updateRes = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  if (updateRes.ok) return;

  // Then create
  const createRes = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to set secret: ${createRes.status} ${errText}`);
  }
}
