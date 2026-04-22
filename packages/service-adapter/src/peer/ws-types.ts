/**
 * WebSocket 実装を差し替え可能にする軽量インターフェース.
 *
 * 本パッケージは Node の `ws` パッケージ / ブラウザ標準 WebSocket / モック
 * どれとも動作する. 利用側がコンストラクタを注入する (既存の
 * `CernereServiceAdapter` と同じパターン).
 */

export interface WsClient {
  /** Node `ws`, Browser WebSocket 共に互換. */
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen:    ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string | Buffer }) => void) | null;
  onclose:   ((ev: unknown) => void) | null;
  onerror:   ((ev: unknown) => void) | null;
}

/** WS クライアントのコンストラクタ. URL と optional headers を受ける. */
export type WsClientFactory = (
  url:    string,
  opts?: { headers?: Record<string, string> },
) => WsClient;

/** サーバ側の 1 接続 (client から見たソケット). */
export interface WsServerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: string) => void): void;
  on(event: "close",   cb: () => void): void;
  on(event: "error",   cb: (err: unknown) => void): void;
}

/** サーバのハンドル. adapter 停止時に close する. */
export interface WsServer {
  close(cb?: () => void): void;
}

/**
 * SA 受信用 WS サーバを起動する関数. 実装は利用側が注入する.
 * 接続ごとに `onConnection` が呼ばれ、認証情報 (Authorization header)
 * と socket を受け渡す.
 */
export type WsServerFactory = (opts: {
  port: number;
  /** Authorization header をそのまま渡す. adapter 側で JWKS 検証. */
  onConnection: (socket: WsServerSocket, authHeader: string | null) => void;
}) => WsServer;
