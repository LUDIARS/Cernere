/**
 * Infisical 接続設定
 */
export interface InfisicalConnection {
  siteUrl: string;
  projectId: string;
  environment: string;
  clientId: string;
  clientSecret: string;
  /** シークレットパス (デフォルト: "/") */
  secretPath?: string;
}

/**
 * EnvInf 初期化オプション
 */
export interface EnvInfOptions {
  /** Infisical 接続設定 */
  connection: InfisicalConnection;
  /** 初期化時に自動で process.env へ展開するか (デフォルト: true) */
  applyToProcessEnv?: boolean;
  /** シャットダウン時に process.env から除去するか (デフォルト: true) */
  removeOnDispose?: boolean;
}

/**
 * 環境変数パラメータの読み取りインタフェース
 */
export interface EnvReader {
  /** ストアからキーを取得 */
  get(key: string): string | undefined;
  /** ストアから全キーを取得 */
  getAll(): Readonly<Record<string, string>>;
  /** キーが存在するか */
  has(key: string): boolean;
  /** ストアのキー一覧 */
  keys(): string[];
}

/**
 * Infisical API から都度取得するインタフェース
 */
export interface EnvFetcher {
  /** API からキーを取得しストアを更新 */
  fetch(key: string): Promise<string | undefined>;
  /** API から全件取得しストアを更新 */
  fetchAll(): Promise<Readonly<Record<string, string>>>;
}

// ─── Infisical API 内部型 ─────────────────────────────────

export interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface RawSecret {
  id: string;
  secretKey: string;
  secretValue: string;
  type: string;
  version: number;
  environment: string;
  secretPath: string;
}

export interface SecretsResponse {
  secrets: RawSecret[];
}
