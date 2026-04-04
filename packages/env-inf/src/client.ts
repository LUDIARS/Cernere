/**
 * Infisical REST API クライアント
 * セッション(トークン)管理を含む
 */

import type {
  InfisicalConnection,
  AuthResponse,
  RawSecret,
  SecretsResponse,
} from "./types.js";

export class InfisicalClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly conn: InfisicalConnection) {}

  /**
   * 有効なアクセストークンを取得 (期限切れなら再認証)
   */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }
    const res = await fetch(
      `${this.conn.siteUrl}/api/v1/auth/universal-auth/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.conn.clientId,
          clientSecret: this.conn.clientSecret,
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Infisical auth failed: ${res.status} ${errText}`);
    }
    const data = (await res.json()) as AuthResponse;
    this.token = data.accessToken;
    // 有効期限の 30 秒前にリフレッシュ
    this.tokenExpiresAt = Date.now() + (data.expiresIn - 30) * 1000;
    return this.token;
  }

  /**
   * シークレット一覧を取得
   */
  async fetchSecrets(secretPath?: string): Promise<RawSecret[]> {
    const token = await this.getToken();
    const path = secretPath ?? this.conn.secretPath ?? "/";
    const params = new URLSearchParams({
      environment: this.conn.environment,
      workspaceId: this.conn.projectId,
      secretPath: path,
    });
    const res = await fetch(
      `${this.conn.siteUrl}/api/v3/secrets/raw?${params}`,
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
  async fetchSecret(key: string, secretPath?: string): Promise<string | undefined> {
    const secrets = await this.fetchSecrets(secretPath);
    const found = secrets.find((s) => s.secretKey === key);
    return found?.secretValue;
  }

  /**
   * セッション情報を破棄
   */
  invalidate(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }
}
