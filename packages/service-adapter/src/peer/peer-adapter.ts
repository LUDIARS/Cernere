/**
 * PeerAdapter — LUDIARS バックエンドサービス間の直接 WS 通信を
 * Cernere project 認証 + JWKS ローカル検証の上に構築するクラス.
 *
 * 使い方 (全サービス共通):
 *
 *   const sa = new PeerAdapter({
 *     projectId:       env.CERNERE_PROJECT_ID,
 *     projectSecret:   env.CERNERE_PROJECT_SECRET,
 *     cernereBaseUrl:  env.CERNERE_URL,
 *     saListenHost:    "0.0.0.0",
 *     saListenPort:    0,                 // dynamic port
 *     saPublicBaseUrl: "wss://actio.internal:{port}", // Cernere に通知するURL
 *   });
 *   sa.handle("ping", async (from, p) => ({ echoed: p }));
 *   await sa.start();
 *
 *   const res = await sa.invoke("imperativus", "ping", { hello: 1 });
 *
 * 7 ステップ protocol (Cernere 仲介 + 60s challenge):
 *   (1) admin が Cernere で relay_pairs に両方向を登録
 *   (2) 両サービスが /api/auth/login → /ws/project?token=... で接続
 *   (3) 各サービスが managed_project.get_jwks で JWKS 取得・cache
 *   (4) 各サービスが SA WS サーバを立てて managed_relay.register_endpoint で自 URL を登録
 *   (5) A が invoke → Cernere に managed_relay.request_peer →
 *       Cernere が relay_pair 確認 + challenge 発行 + B の SA URL を A に返却
 *   (6) A が B へ WS 接続. header Authorization: Bearer <A project JWT> + X-Relay-Challenge
 *   (7) B が:
 *       - JWT を JWKS (=(3) で取得) で local verify → A の projectKey 取得
 *       - managed_relay.verify_challenge で challenge を Cernere に照会 →
 *         issuer が A projectKey と一致、target が自身であることを確認
 *       成立したら channel 確立. 以降データ経路に Cernere は介在しない.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";

import { CernereSession } from "./cernere-session.js";
import { JwksCache } from "./jwks-cache.js";
import {
  type Envelope,
  type InvokeEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PeerError,
} from "./envelope.js";

export interface PeerAdapterConfig {
  projectId:      string;                  // Cernere managed_projects.client_id
  projectSecret:  string;                  // Cernere managed_projects.client_secret
  cernereBaseUrl: string;                  // e.g. "http://localhost:8080"
  /** 自 SA WS をバインドするホスト (default: 0.0.0.0). */
  saListenHost?:  string;
  /** 自 SA WS をバインドするポート (0 = 動的). */
  saListenPort?:  number;
  /**
   * Cernere に通知する「外部から到達可能な」 WS URL. `{port}` プレースホルダを
   * 使うと実際のバインドポートに置換. 例 "wss://actio.internal:{port}".
   */
  saPublicBaseUrl: string;
  /**
   * 受け入れる peer プロジェクトキー + そのプロジェクトから許可するコマンド.
   * 例: { imperativus: ["ping", "tasks.create"] }.
   * `*` を指定すると全コマンドを許可.
   */
  accept?: Record<string, "*" | string[]>;
  /** 1 invoke のデフォルトタイムアウト (ms). Default 10s. */
  invokeTimeoutMs?: number;
}

export type PeerHandler = (
  from:    { projectKey: string; clientId: string },
  payload: unknown,
) => Promise<unknown> | unknown;

interface Pending {
  resolve: (v: unknown) => void;
  reject:  (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PeerChannel {
  ws:            WebSocket;
  projectKey:    string;      // 接続相手の projectKey
  pending:       Map<string, Pending>;
  /** "open" | "closing". "closed" なら Map から除去済. */
  state:         "open" | "closing";
}

// ─── PeerAdapter ──────────────────────────────────────────────

export class PeerAdapter {
  private readonly config: Required<Omit<PeerAdapterConfig, "accept">> & {
    accept: NonNullable<PeerAdapterConfig["accept"]>;
  };
  private session:      CernereSession | null = null;
  private jwks:         JwksCache | null = null;
  private httpServer:   HttpServer | null = null;
  private wsServer:     WebSocketServer | null = null;
  private boundPort    = 0;
  private handlers     = new Map<string, PeerHandler>();
  /** projectKey → channel (outbound). 再利用されるまで保持. */
  private outbound     = new Map<string, PeerChannel>();
  /** inbound で upgrade した WS. stop() 時に全部閉じる. */
  private inbound      = new Set<WebSocket>();
  private stopped      = false;

  constructor(config: PeerAdapterConfig) {
    this.config = {
      saListenHost:    "0.0.0.0",
      saListenPort:    0,
      accept:          {},
      invokeTimeoutMs: 10_000,
      ...config,
    };
  }

  // ── 起動 / 停止 ─────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;

    // (4) 自 SA WS サーバを立てる (dynamic port サポート).
    await this.startWsServer();

    // (2) Cernere project 認証 + WS session
    this.session = new CernereSession({
      cernereBaseUrl: this.config.cernereBaseUrl,
      projectId:      this.config.projectId,
      projectSecret:  this.config.projectSecret,
      wsFactory:      (url) => new WebSocket(url) as unknown as ReturnType<CernereSessionConfigWsFactory>,
    });
    await this.session.start();

    // (3) JWKS fetch
    const rawJwks = await this.session.call<{ keys: unknown[] }>(
      "managed_project",
      "get_jwks",
      {},
    );
    this.jwks = new JwksCache(async () => {
      return await this.session!.call<{ keys: unknown[] }>("managed_project", "get_jwks", {}) as never;
    });
    // 最初の取得を直接 JwksCache に反映させるため、ダミーの refresh を回さず強制 load:
    await this.jwks.refresh();
    void rawJwks;

    // (4) endpoint 登録
    const publicUrl = this.config.saPublicBaseUrl.replace("{port}", String(this.boundPort));
    await this.session.call("managed_relay", "register_endpoint", { saWsUrl: publicUrl });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // 既存 outbound channel を閉じる
    for (const ch of this.outbound.values()) {
      ch.state = "closing";
      for (const p of ch.pending.values()) { clearTimeout(p.timeout); p.reject(new Error("stopped")); }
      try { ch.ws.close(); } catch { /* ignore */ }
    }
    this.outbound.clear();

    // inbound 側も強制切断 — これをやらないと httpServer.close() が
    // 既存接続の drain を待ってハングする.
    for (const ws of this.inbound) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    this.inbound.clear();

    if (this.session) {
      try { await this.session.call("managed_relay", "unregister_endpoint", {}); } catch { /* ignore */ }
      await this.session.stop();
      this.session = null;
    }
    if (this.wsServer)   { await new Promise<void>((r) => this.wsServer!.close(() => r())); this.wsServer = null; }
    if (this.httpServer) {
      // Node 18.2+ の closeAllConnections でアイドル keep-alive も切る.
      const h = this.httpServer;
      (h as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => h.close(() => r()));
      this.httpServer = null;
    }
  }

  // ── 公開 API ────────────────────────────────────────

  handle(command: string, handler: PeerHandler): void {
    this.handlers.set(command, handler);
  }

  async invoke<T = unknown>(
    target: string,
    command: string,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.stopped) throw new Error("[peer-adapter] stopped");
    if (!this.session) throw new Error("[peer-adapter] not started");

    const ch = await this.ensureChannel(target);
    const id = randomUUID();
    const env: InvokeEnvelope = { id, type: "invoke", command, payload };

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.config.invokeTimeoutMs;
      const timeout = setTimeout(() => {
        ch.pending.delete(id);
        reject(new Error(`[peer-adapter] invoke timeout ${target}.${command}`));
      }, timeoutMs);
      ch.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timeout,
      });
      ch.ws.send(encodeEnvelope(env));
    });
  }

  /** 現在 bind 中のポート (start 後に有効). */
  get boundListenPort(): number { return this.boundPort; }

  // ── 内部 — outbound channel 確立 (5)-(6) ────────────

  private async ensureChannel(target: string): Promise<PeerChannel> {
    const existing = this.outbound.get(target);
    if (existing && existing.state === "open") return existing;

    // (5) Cernere に request_peer
    const pr = await this.session!.call<{
      saWsUrl:   string;
      challenge: string;
      expiresAt: number;
    }>("managed_relay", "request_peer", { target });

    // (6) peer WS 接続
    const ownToken = await this.requireProjectToken();
    const ws = new WebSocket(pr.saWsUrl, {
      headers: {
        Authorization:      `Bearer ${ownToken}`,
        "X-Relay-Challenge": pr.challenge,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open",  () => resolve());
      ws.once("error", (err) => reject(err));
    });

    const channel: PeerChannel = {
      ws,
      projectKey: target,
      pending:    new Map(),
      state:      "open",
    };
    this.wireOutgoingChannel(channel);
    this.outbound.set(target, channel);
    return channel;
  }

  private wireOutgoingChannel(ch: PeerChannel): void {
    ch.ws.on("message", (data: RawData) => {
      const env = decodeEnvelope(data.toString());
      if (!env) return;
      this.routeIncoming(env, ch);
    });
    ch.ws.on("close", () => {
      ch.state = "closing";
      for (const p of ch.pending.values()) {
        clearTimeout(p.timeout);
        p.reject(new PeerError("peer_disconnected", `peer ${ch.projectKey} disconnected`));
      }
      ch.pending.clear();
      this.outbound.delete(ch.projectKey);
    });
  }

  // ── 内部 — inbound WS (7): accept & verify ─────────

  private async startWsServer(): Promise<void> {
    const server = createServer();
    const wsServer = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head, wsServer);
    });

    await new Promise<void>((resolve) => {
      server.listen(this.config.saListenPort, this.config.saListenHost, () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.config.saListenPort;
        resolve();
      });
    });
    this.httpServer = server;
    this.wsServer   = wsServer;
  }

  private async handleUpgrade(
    req:    IncomingMessage,
    socket: import("node:stream").Duplex,
    head:   Buffer,
    wsServer: WebSocketServer,
  ): Promise<void> {
    const bearer   = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const challenge = typeof req.headers["x-relay-challenge"] === "string"
      ? (req.headers["x-relay-challenge"] as string) : "";
    if (!bearer || !challenge) { return this.deny(socket, "missing auth or challenge"); }
    if (!this.jwks || !this.session) { return this.deny(socket, "adapter not started"); }

    // (7a) JWT を JWKS で local verify
    let claims;
    try { claims = await this.jwks.verifyProjectToken(bearer); }
    catch { return this.deny(socket, "invalid token"); }

    // (7b) challenge を Cernere に照会 (issuer = JWT から抽出した projectKey)
    try {
      const res = await this.session.call<{ valid: true }>(
        "managed_relay", "verify_challenge",
        { challenge, claimedIssuer: claims.projectKey },
      );
      if (!res.valid) return this.deny(socket, "challenge rejected");
    } catch { return this.deny(socket, "challenge rejected"); }

    // (7c) accept list 判定. 設定が空なら全 peer 拒否 (fail-closed).
    const acceptedCmds = this.config.accept[claims.projectKey];
    if (!acceptedCmds) return this.deny(socket, `peer ${claims.projectKey} not in accept list`);

    // upgrade OK
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      const caller = { projectKey: claims.projectKey, clientId: claims.sub };
      this.inbound.add(ws);
      ws.on("close", () => this.inbound.delete(ws));
      this.wireIncomingChannel(ws, caller, acceptedCmds);
    });
  }

  private wireIncomingChannel(
    ws:       WebSocket,
    caller:   { projectKey: string; clientId: string },
    accepted: "*" | string[],
  ): void {
    ws.on("message", async (data: RawData) => {
      const env = decodeEnvelope(data.toString());
      if (!env) return;
      if (env.type === "invoke") {
        if (accepted !== "*" && !accepted.includes(env.command)) {
          ws.send(encodeEnvelope({
            id: env.id, type: "error",
            error: { code: "forbidden", message: `command not allowed: ${env.command}` },
          }));
          return;
        }
        const handler = this.handlers.get(env.command);
        if (!handler) {
          ws.send(encodeEnvelope({
            id: env.id, type: "error",
            error: { code: "unknown_command", message: env.command },
          }));
          return;
        }
        try {
          const result = await handler(caller, env.payload);
          ws.send(encodeEnvelope({ id: env.id, type: "response", result }));
        } catch (err) {
          ws.send(encodeEnvelope({
            id: env.id, type: "error",
            error: { code: "handler_threw", message: (err as Error).message },
          }));
        }
      }
      // response / error はこちらで掴まない (inbound channel では来ない想定)
    });
  }

  private routeIncoming(env: Envelope, ch: PeerChannel): void {
    if (env.type === "response") {
      const p = ch.pending.get(env.id);
      if (!p) return;
      ch.pending.delete(env.id);
      clearTimeout(p.timeout);
      p.resolve(env.result);
    } else if (env.type === "error") {
      const p = ch.pending.get(env.id);
      if (!p) return;
      ch.pending.delete(env.id);
      clearTimeout(p.timeout);
      p.reject(new PeerError(env.error.code, env.error.message));
    }
  }

  private deny(socket: import("node:stream").Duplex, reason: string): void {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${reason}`);
    socket.destroy();
  }

  /** project token を CernereSession から取り出す. session 起動後にのみ有効. */
  private async requireProjectToken(): Promise<string> {
    if (!this.session) throw new Error("session not started");
    const tok = this.session.currentProjectToken;
    if (!tok) throw new Error("project token not yet obtained");
    return tok;
  }
}

// 型ブリッジ: CernereSession の wsFactory が期待する型名を抽出する補助.
// CernereSession 側の WsClientFactory に `ws` パッケージの WebSocket を
// そのまま渡せるよう、署名を合わせる wrapper.
type CernereSessionConfigWsFactory =
  import("./ws-types.js").WsClientFactory;
