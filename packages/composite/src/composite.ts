/**
 * @ludiars/cernere-composite — バックエンド認証コンポジット
 *
 * サービスのバックエンドに組み込み、以下を提供する:
 * 1. 起動時の Cernere プロジェクト認証 (WebSocket service_auth)
 * 2. Cernere Composite ログイン URL の生成
 * 3. auth_code → service_token 交換 (Backend 経由)
 */

import { CernereServiceAdapter } from "@ludiars/cernere-service-adapter";
import type { ServiceAdapterCallbacks, AdmittedUser } from "@ludiars/cernere-service-adapter";
import type { CompositeConfig, CernereUser, ExchangeResult } from "./types.js";

export class CernereComposite {
  private adapter: CernereServiceAdapter;
  private readonly config: CompositeConfig;
  private readonly tokenExpiresIn: number;

  constructor(config: CompositeConfig, callbacks?: ServiceAdapterCallbacks, wsClass?: unknown) {
    this.config = config;
    this.tokenExpiresIn = config.tokenExpiresIn ?? 900;

    this.adapter = new CernereServiceAdapter(
      {
        cernereWsUrl: config.cernereWsUrl,
        serviceCode: config.serviceCode,
        serviceSecret: config.serviceSecret,
        jwtSecret: config.jwtSecret,
        tokenExpiresIn: this.tokenExpiresIn,
      },
      callbacks ?? {},
      wsClass as undefined,
    );
  }

  /** Cernere に WebSocket 接続し、プロジェクト認証を行う */
  connect(): void {
    this.adapter.connect();
  }

  /** 切断 */
  disconnect(): void {
    this.adapter.disconnect();
  }

  /** 接続済みか */
  get connected(): boolean {
    return this.adapter.connected;
  }

  /** ユーザーが revoke されているか */
  isRevoked(userId: string): boolean {
    return this.adapter.isRevoked(userId);
  }

  /**
   * Cernere Composite ログインページの URL を返す。
   * Frontend はこの URL を popup で開く。
   *
   * @param origin - postMessage の送信先 (Frontend の origin)
   */
  getLoginUrl(origin: string): string {
    return `${this.config.cernereUrl}/composite/login?origin=${encodeURIComponent(origin)}`;
  }

  /**
   * auth_code を Cernere に送信してトークンに交換し、
   * service_token を発行して返す。
   *
   * Frontend から受け取った authCode を Backend 経由で処理する。
   */
  async exchange(authCode: string): Promise<ExchangeResult> {
    const res = await fetch(`${this.config.cernereUrl}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: authCode }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cernere exchange failed: ${res.status} ${body}`);
    }

    const data = await res.json() as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; displayName: string; email: string; role: string };
    };

    // service_token を発行
    const serviceToken = await this.issueServiceToken({
      id: data.user.id,
      displayName: data.user.displayName,
      email: data.user.email,
      role: data.user.role,
    });

    return {
      serviceToken,
      user: data.user,
    };
  }

  /**
   * refreshToken で Cernere トークンをリフレッシュし、
   * 新しい service_token を発行して返す。
   */
  async refresh(refreshToken: string): Promise<ExchangeResult | null> {
    const res = await fetch(`${this.config.cernereUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return null;

    const data = await res.json() as { accessToken: string; refreshToken: string };

    // accessToken から user 情報を取得
    const meRes = await fetch(`${this.config.cernereUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });

    if (!meRes.ok) return null;

    const me = await meRes.json() as { id: string; name: string; email: string; role: string };
    const user: CernereUser = {
      id: me.id,
      displayName: me.name,
      email: me.email,
      role: me.role,
    };

    const serviceToken = await this.issueServiceToken(user);
    return { serviceToken, user };
  }

  // ── 内部 ──────────────────────────────────────

  private async issueServiceToken(user: CernereUser): Promise<string> {
    const header = { alg: "HS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.id,
      name: user.displayName,
      email: user.email,
      role: user.role,
      iat: now,
      exp: now + this.tokenExpiresIn,
      iss: this.config.serviceCode,
    };

    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const headerB64 = enc(header);
    const payloadB64 = enc(payload);
    const data = `${headerB64}.${payloadB64}`;

    const crypto = await import("node:crypto");
    const signature = crypto
      .createHmac("sha256", this.config.jwtSecret)
      .update(data)
      .digest("base64url");

    return `${data}.${signature}`;
  }
}
