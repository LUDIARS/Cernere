/**
 * @ludiars/cernere-composite — 型定義
 *
 * バックエンド用。サービスが Cernere に接続し、
 * ユーザー認証を仲介するための型。
 */

/** Composite 設定 */
export interface CompositeConfig {
  /** Cernere サーバーの HTTP URL (例: "http://localhost:8080") */
  cernereUrl: string;
  /** Cernere WebSocket URL (例: "ws://localhost:8080/ws/service") */
  cernereWsUrl: string;
  /** サービスコード (例: "schedula") */
  serviceCode: string;
  /** サービスシークレット */
  serviceSecret: string;
  /** サービス側 JWT シークレット (service_token 発行用) */
  jwtSecret: string;
  /** service_token の有効期間 (秒, default: 900 = 15分) */
  tokenExpiresIn?: number;
}

/** Cernere ユーザー情報 */
export interface CernereUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

/** auth_code 交換後の結果 */
export interface ExchangeResult {
  /** サービス側で発行した service_token (サービス API 呼び出し用) */
  serviceToken: string;
  /** ユーザー情報 */
  user: CernereUser;
}
