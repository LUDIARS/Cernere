/**
 * @cernere/service-adapter — 型定義
 */

// ── Cernere → Service メッセージ ──────────────────

export interface ServiceAuthenticatedMsg {
  type: "service_authenticated";
  service_id: string;
}

export interface UserAdmissionMsg {
  type: "user_admission";
  ticket_id: string;
  user: AdmittedUser;
  organization_id: string | null;
  scopes: string[];
}

export interface UserRevokeMsg {
  type: "user_revoke";
  user_id: string;
}

export interface PingMsg {
  type: "ping";
  ts: number;
}

export interface ErrorMsg {
  type: "error";
  code: string;
  message: string;
}

export type CernereMessage =
  | ServiceAuthenticatedMsg
  | UserAdmissionMsg
  | UserRevokeMsg
  | PingMsg
  | ErrorMsg;

// ── Service → Cernere メッセージ ──────────────────

export interface ServiceAuthMsg {
  type: "service_auth";
  service_code: string;
  service_secret: string;
}

export interface AdmissionResponseMsg {
  type: "admission_response";
  ticket_id: string;
  service_token: string;
  expires_in: number;
}

export interface PongMsg {
  type: "pong";
  ts: number;
}

// ── ユーザーデータ ────────────────────────────────

export interface AdmittedUser {
  id: string;
  login: string;
  displayName: string;
  email: string | null;
  avatarUrl: string;
  role: string;
}

// ── アダプタ設定 ──────────────────────────────────

export interface ServiceAdapterConfig {
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
  /** 再接続間隔 (ミリ秒, default: 5000) */
  reconnectIntervalMs?: number;
}

// ── コールバック ──────────────────────────────────

export interface ServiceAdapterCallbacks {
  /** ユーザー受け入れ時に呼ばれる。ユーザーデータの保存などに使用 */
  onUserAdmission?: (user: AdmittedUser, organizationId: string | null, scopes: string[]) => Promise<void>;
  /** ユーザー無効化時に呼ばれる。セッション破棄などに使用 */
  onUserRevoke?: (userId: string) => Promise<void>;
  /** 接続成功時 */
  onConnected?: (serviceId: string) => void;
  /** 切断時 */
  onDisconnected?: () => void;
  /** エラー時 */
  onError?: (code: string, message: string) => void;
}
