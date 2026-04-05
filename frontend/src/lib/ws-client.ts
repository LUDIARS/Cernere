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

  get connected() { return this._connected; }
  get sessionId() { return this._sessionId; }

  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/auth?token=${encodeURIComponent(token)}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log("[ws] Connected");
      };

      this.ws.onmessage = (evt) => {
        const msg: ServerMessage = JSON.parse(evt.data);
        this.handleMessage(msg, resolve);
      };

      this.ws.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = () => {
        this._connected = false;
        this._sessionId = null;
        console.log("[ws] Disconnected");
      };
    });
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this._sessionId = null;
  }

  onMessage(listener: (msg: ServerMessage) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async sendCommand<T = unknown>(module: string, action: string, payload?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.push({
        resolve: resolve as (p: unknown) => void,
        reject,
        module,
        action,
      });

      this.ws!.send(JSON.stringify({
        type: "module_request",
        module,
        action,
        payload,
      }));
    });
  }

  private handleMessage(msg: ServerMessage, onConnect?: (value: void) => void) {
    switch (msg.type) {
      case "connected":
        this._connected = true;
        this._sessionId = msg.session_id ?? null;
        onConnect?.();
        break;

      case "module_response": {
        const idx = this.pendingRequests.findIndex(
          (r) => r.module === msg.module && r.action === msg.action,
        );
        if (idx >= 0) {
          const req = this.pendingRequests.splice(idx, 1)[0];
          req.resolve(msg.payload);
        }
        break;
      }

      case "error": {
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
