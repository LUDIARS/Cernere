/**
 * Infisical 認証情報 (Universal Auth)
 */
export interface InfisicalBootstrap {
  siteUrl: string;
  projectId: string;
  environment: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Infisical API レスポンスの個別シークレット
 */
export interface RawSecret {
  id: string;
  secretKey: string;
  secretValue: string;
  type: string;
  version: number;
  environment: string;
  secretPath: string;
}

/**
 * プロジェクト固有の設定。
 * 利用側が env-cli.config.ts で定義する。
 */
export interface EnvCliConfig {
  /** プロジェクト名 (CLI ヘッダーに表示) */
  name: string;

  /**
   * Docker 用 .env に出力するインフラキーとデフォルト値。
   * Infisical に同名キーがあればそちらを優先する。
   */
  infraKeys: Record<string, string>;

  /** .env.secrets の保存先 (デフォルト: cwd/.env.secrets) */
  secretsPath?: string;

  /** .env の出力先 (デフォルト: cwd/.env) */
  dotenvPath?: string;

  /** Infisical デフォルト Site URL */
  defaultSiteUrl?: string;

  /** Infisical デフォルト Environment */
  defaultEnvironment?: string;
}

// ─── Infisical internal types ──────────────────────────────

export interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface SecretsResponse {
  secrets: RawSecret[];
}
