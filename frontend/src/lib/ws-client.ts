/**
 * Cernere WebSocket クライアント
 *
 * 認証済みセッションを管理し、module_request の送受信を行う。
 */

type ServerMessage = {
  type: string;
  session_id?: string;
  module?: string;
  action?: string;
  payload?: unknown;
  code?: string;
  message?: string;
  ts?: number;
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  module: string;
  action: string;
};

class CernereWsClient {
  private ws: WebSocket | null = null;
  private pendingRequests: PendingRequest[] = [];
  private listeners: Array<(msg: ServerMessage) => void> = [];
  private _connected = false;
  private _sessionId: string | null = null;
  private connectPromise: Promise<void> | null = null;

  get connected() { return this._connected; }
  get sessionId() { return this._sessionId; }

  connect(token: string): Promise<void> {
    // 既に接続中 or 接続済み
    if (this._connected) {
      console.log("[ws] Already connected, skipping");
      return Promise.resolve();
    }
    if (this.connectPromise) {
      console.log("[ws] Connection already in progress, waiting");
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/auth?token=${encodeURIComponent(token)}`;
      console.log("[ws] Connecting to:", url);

      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        console.error("[ws] Connection timeout (10s)");
        this.connectPromise = null;
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ws.onopen = () => {
        console.log("[ws] Socket opened, waiting for server connected message...");
      };

      this.ws.onmessage = (evt) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          console.error("[ws] Failed to parse message:", evt.data);
          return;
        }
        console.log("[ws] ←", msg.type, msg.module ? `${msg.module}.${msg.action}` : "");
        this.handleMessage(msg, () => {
          clearTimeout(timeout);
          this.connectPromise = null;
          resolve();
        });
      };

      this.ws.onerror = (evt) => {
        console.error("[ws] WebSocket error:", evt);
        clearTimeout(timeout);
        this.connectPromise = null;
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = (evt) => {
        this._connected = false;
        this._sessionId = null;
        this.connectPromise = null;
        console.log("[ws] Disconnected (code:", evt.code, "reason:", evt.reason || "none", ")");
      };
    });

    return this.connectPromise;
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this._sessionId = null;
    this.connectPromise = null;
  }

  onMessage(listener: (msg: ServerMessage) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * WS コマンド送信。接続がまだの場合は最大 5 秒待つ。
   */
  async sendCommand<T = unknown>(module: string, action: string, payload?: unknown): Promise<T> {
    // 接続待ち
    if (!this._connected && this.connectPromise) {
      console.log(`[ws] Waiting for connection before ${module}.${action}...`);
      await this.connectPromise;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const state = this.ws ? this.ws.readyState : "no socket";
      console.error(`[ws] Cannot send ${module}.${action}: not connected (state: ${state})`);
      throw new Error("WebSocket not connected");
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.push({
        resolve: resolve as (p: unknown) => void,
        reject,
        module,
        action,
      });

      const msg = { type: "module_request", module, action, payload };
      console.log("[ws] →", module, action);
      this.ws!.send(JSON.stringify(msg));
    });
  }

  private handleMessage(msg: ServerMessage, onConnect?: () => void) {
    switch (msg.type) {
      case "connected":
        this._connected = true;
        this._sessionId = msg.session_id ?? null;
        console.log("[ws] Session established:", this._sessionId);
        onConnect?.();
        break;

      case "guest_connected":
        console.log("[ws] Guest session:", msg.session_id);
        break;

      case "module_response": {
        const idx = this.pendingRequests.findIndex(
          (r) => r.module === msg.module && r.action === msg.action,
        );
        if (idx >= 0) {
          const req = this.pendingRequests.splice(idx, 1)[0];
          req.resolve(msg.payload);
        } else {
          console.warn("[ws] Unmatched module_response:", msg.module, msg.action);
        }
        break;
      }

      case "error": {
        console.error("[ws] Server error:", msg.code, msg.message);
        const pending = this.pendingRequests.shift();
        if (pending) {
          pending.reject(new Error(msg.message ?? "Unknown error"));
        }
        break;
      }

      case "ping":
        this.ws?.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        break;
    }

    for (const listener of this.listeners) {
      listener(msg);
    }
  }
}

export const wsClient = new CernereWsClient();
