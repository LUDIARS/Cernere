/**
 * @cernere/service-adapter — メインアダプタ
 *
 * サービスが Cernere に WebSocket 接続し、
 * ユーザー受け入れ (admission) / 無効化 (revoke) を処理する。
 */

import type {
  ServiceAdapterConfig,
  ServiceAdapterCallbacks,
  CernereMessage,
  AdmittedUser,
} from "./types.js";

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string | Buffer }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

type WsConstructor = new (url: string) => WebSocketLike;

const DEFAULT_TOKEN_EXPIRES_IN = 900; // 15 minutes
const DEFAULT_RECONNECT_MS = 5000;

export class CernereServiceAdapter {
  private config: Required<ServiceAdapterConfig>;
  private callbacks: ServiceAdapterCallbacks;
  private ws: WebSocketLike | null = null;
  private serviceId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private WsClass: WsConstructor;

  /** 無効化されたユーザー ID のセット (サービス側で service_token を拒否するために使う) */
  private revokedUsers = new Set<string>();

  constructor(
    config: ServiceAdapterConfig,
    callbacks: ServiceAdapterCallbacks = {},
    wsClass?: WsConstructor,
  ) {
    this.config = {
      tokenExpiresIn: DEFAULT_TOKEN_EXPIRES_IN,
      reconnectIntervalMs: DEFAULT_RECONNECT_MS,
      ...config,
    };
    this.callbacks = callbacks;

    // Node.js / ブラウザ両対応
    if (wsClass) {
      this.WsClass = wsClass;
    } else if (typeof WebSocket !== "undefined") {
      this.WsClass = WebSocket as unknown as WsConstructor;
    } else {
      throw new Error(
        "WebSocket class not found. Pass a WebSocket implementation (e.g. 'ws' package) as the third argument.",
      );
    }
  }

  /** Cernere に接続 (自動再接続あり) */
  connect(): void {
    this.ws = new this.WsClass(this.config.cernereWsUrl);

    this.ws.onopen = () => {
      // 接続したら service_auth を送信
      this.send({
        type: "service_auth",
        service_code: this.config.serviceCode,
        service_secret: this.config.serviceSecret,
      });
    };

    this.ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
      try {
        const msg = JSON.parse(data) as CernereMessage;
        this.handleMessage(msg);
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.callbacks.onDisconnected?.();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will be called after onerror
    };
  }

  /** 切断 (再接続なし) */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  /** 接続中かどうか */
  get connected(): boolean {
    return this._connected;
  }

  /** ユーザーが無効化されているか確認 */
  isRevoked(userId: string): boolean {
    return this.revokedUsers.has(userId);
  }

  /** 無効化リストをクリア */
  clearRevoked(): void {
    this.revokedUsers.clear();
  }

  // ── 内部 ──────────────────────────────────────

  private handleMessage(msg: CernereMessage): void {
    switch (msg.type) {
      case "service_authenticated":
        this.serviceId = msg.service_id;
        this._connected = true;
        this.callbacks.onConnected?.(msg.service_id);
        break;

      case "user_admission":
        this.handleAdmission(msg.ticket_id, msg.user, msg.organization_id, msg.scopes);
        break;

      case "user_revoke":
        this.revokedUsers.add(msg.user_id);
        this.callbacks.onUserRevoke?.(msg.user_id);
        break;

      case "ping":
        this.send({ type: "pong", ts: msg.ts });
        break;

      case "error":
        this.callbacks.onError?.(msg.code, msg.message);
        if (msg.code === "auth_failed" || msg.code === "service_not_found") {
          // 認証失敗時は再接続しない
          this.disconnect();
        }
        break;
    }
  }

  private async handleAdmission(
    ticketId: string,
    user: AdmittedUser,
    organizationId: string | null,
    scopes: string[],
  ): Promise<void> {
    try {
      // コールバックでサービス側のユーザーデータ保存
      await this.callbacks.onUserAdmission?.(user, organizationId, scopes);

      // service_token を発行
      const serviceToken = await this.issueServiceToken(user);

      // Cernere に admission_response を返す
      this.send({
        type: "admission_response",
        ticket_id: ticketId,
        service_token: serviceToken,
        expires_in: this.config.tokenExpiresIn,
      });
    } catch (err) {
      console.error("[CernereAdapter] Failed to handle admission:", err);
    }
  }

  /**
   * service_token を発行する。
   * デフォルト実装: 簡易 JWT (Base64 エンコード)。
   * 本番環境では jsonwebtoken パッケージの使用を推奨。
   */
  private async issueServiceToken(user: AdmittedUser): Promise<string> {
    // JWT ヘッダー + ペイロード を手動構成 (外部依存なし)
    const header = { alg: "HS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.id,
      name: user.displayName,
      email: user.email,
      role: user.role,
      iat: now,
      exp: now + this.config.tokenExpiresIn,
      iss: this.config.serviceCode,
    };

    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const headerB64 = enc(header);
    const payloadB64 = enc(payload);
    const data = `${headerB64}.${payloadB64}`;

    // HMAC-SHA256 署名
    const crypto = await import("node:crypto");
    const signature = crypto
      .createHmac("sha256", this.config.jwtSecret)
      .update(data)
      .digest("base64url");

    return `${data}.${signature}`;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectIntervalMs);
  }
}
