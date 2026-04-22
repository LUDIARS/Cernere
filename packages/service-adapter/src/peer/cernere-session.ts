/**
 * Cernere WS セッション (project 認証版).
 *
 * Phase 0a で追加された `/ws/project?token=<projectJwt>` に接続し、
 * `managed_project.*` コマンドを実行する薄いクライアント.
 *
 * Service adapter 自体が Cernere の "project" として振る舞うため、起動時に
 * 1. `POST /api/auth/login grant_type=project_credentials` で project token を取得
 * 2. その token で WS 接続
 * 3. コマンド (`get_jwks`, `get_user_data`, ...) を module_request で実行
 *
 * ※ 再接続・token refresh 等の強化は後段で追加 (MVP は明示的 start/stop).
 */

import type { WsClient, WsClientFactory } from "./ws-types.js";

export interface CernereSessionConfig {
  /** 例: "https://cernere.local:8080" (httpとwsのhost共通前提) */
  cernereBaseUrl: string;
  /** managed_projects.client_id */
  projectId:      string;
  /** managed_projects.client_secret (起動時にだけ使用) */
  projectSecret:  string;
  /** WebSocket クライアント生成関数 (Node の `ws` パッケージ等) */
  wsFactory:      WsClientFactory;
  /** fetch 関数 (Node 22+ の global fetch で OK) */
  fetch?:         typeof fetch;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject:  (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CernereSession {
  private config:      CernereSessionConfig;
  private ws:          WsClient | null = null;
  private projectToken: string | null = null;
  private pending     = new Map<string, Pending>();
  private connected   = false;
  private cmdCounter  = 0;

  constructor(config: CernereSessionConfig) {
    this.config = config;
  }

  /** 起動時ハンドシェイク: login → WS open → "connected" 到達まで待つ. */
  async start(): Promise<void> {
    this.projectToken = await this.login();
    await this.openWs(this.projectToken);
  }

  /** 現在有効な project JWT. PeerAdapter が peer 接続の Authorization に使う. */
  get currentProjectToken(): string | null {
    return this.projectToken;
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error("[cernere-session] stopped"));
    }
    this.pending.clear();
  }

  /**
   * managed_project コマンドを実行. WS `module_request` を送信し、
   * 対応する module_response / error を Promise で返す.
   */
  async call<T = unknown>(
    module: string,
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.connected || !this.ws) {
      throw new Error("[cernere-session] not connected; call start() first");
    }
    const reqId = `req-${++this.cmdCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`[cernere-session] timeout ${module}.${action}`));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as T),
        reject,
        timeout,
      });
      this.ws!.send(JSON.stringify({
        type:    "module_request",
        module,
        action,
        payload,
        request_id: reqId,
      }));
    });
  }

  /** login の raw response (project token). */
  private async login(): Promise<string> {
    const f = this.config.fetch ?? fetch;
    const res = await f(`${this.config.cernereBaseUrl}/api/auth/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        grant_type:    "project_credentials",
        client_id:     this.config.projectId,
        client_secret: this.config.projectSecret,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`[cernere-session] login failed (${res.status}): ${body}`);
    }
    const data = await res.json() as { access_token?: string; project_token?: string };
    const tok = data.project_token ?? data.access_token;
    if (!tok) throw new Error("[cernere-session] login response missing project token");
    return tok;
  }

  /** WS を開き "connected" メッセージを受信するまで待つ. */
  private async openWs(token: string): Promise<void> {
    const wsUrl = this.toWsUrl(`/ws/project?token=${encodeURIComponent(token)}`);
    const ws = this.config.wsFactory(wsUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onceConnected = () => { this.connected = true; resolve(); };
      const onError = (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : ev.data.toString();
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw); } catch { return; }

        // Cernere の最初の "connected" シグナル.
        if (msg.type === "connected") { onceConnected(); return; }

        // 応答
        if (msg.type === "module_response" || msg.type === "error") {
          const id = (msg.request_id ?? msg.id) as string | undefined;
          if (!id) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          clearTimeout(entry.timeout);
          if (msg.type === "module_response") {
            entry.resolve(msg.payload);
          } else {
            entry.reject(new Error(String((msg.message ?? msg.code) ?? "cernere error")));
          }
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        }
      };
      ws.onerror = onError;
      ws.onclose = () => {
        this.connected = false;
        if (this.pending.size === 0) return;
        const err = new Error("[cernere-session] ws closed");
        for (const p of this.pending.values()) { clearTimeout(p.timeout); p.reject(err); }
        this.pending.clear();
      };
    });
  }

  private toWsUrl(path: string): string {
    const base = this.config.cernereBaseUrl;
    if (base.startsWith("https://")) return `wss://${base.slice(8)}${path}`;
    if (base.startsWith("http://"))  return `ws://${base.slice(7)}${path}`;
    return `${base}${path}`;
  }
}
