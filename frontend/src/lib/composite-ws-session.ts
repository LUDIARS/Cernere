/**
 * composite 認証の WS セッション (`/auth/composite-ws?ticket=...`)。
 *
 * password ログイン / 登録は REST で資格情報を検証したあと、 この WS で
 * fingerprint 送信 → 本人確認コード → authCode の順に進む
 * (server/src/ws/composite-auth.ts)。 ここではその状態機械を Promise に畳み、
 * <CompositeLogin> の authApi (login → deviceVerify → ...) から呼べる形にする。
 *
 * 1 セッション = 1 WS。 open / verifyCode / resend は「次の決着」 を待つ。
 */

import type { DeviceFingerprint } from "@ludiars/cernere-composite/ui";
import { collectDeviceFingerprint } from "./device-fingerprint";

export type CompositeAnomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
  | "new_ip"
  | "missing_fingerprint";

export interface CompositeChallengeInfo {
  deviceToken?: string;
  emailMasked?: string;
  anomalies?: CompositeAnomaly[];
  codeChannel?: "email" | "console";
  deviceLabel?: string;
  error?: string;
  remainingAttempts?: number;
  resent?: boolean;
}

/** open / verifyCode が返す「決着」 */
export type CompositeWsOutcome =
  | { kind: "challenge"; data: CompositeChallengeInfo }
  | { kind: "authenticated"; authCode: string };

type WsState = "pending_device" | "challenge_pending" | "authenticated" | "expired";

type ServerMessage =
  | { type: "state"; state: WsState; data?: CompositeChallengeInfo }
  | { type: "authenticated"; authCode: string }
  | { type: "error"; retryable: boolean; reason: string }
  | { type: "ping"; ts: number };

interface Waiter {
  resolve: (outcome: CompositeWsOutcome) => void;
  reject: (err: Error) => void;
}

const FINGERPRINT_RETRY_DELAY_MS = 500;
const MAX_FINGERPRINT_RETRIES = 3;

/** WS の URL を構築する (HTTPS → wss, HTTP → ws)。 開発時は Vite proxy 下で動くため location.host。 */
function buildWsUrl(wsPath: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${wsPath}`;
}

export class CompositeWsSession {
  private ws: WebSocket | null = null;
  private waiter: Waiter | null = null;
  private fingerprintSent = false;
  private fingerprintRetryCount = 0;
  private fingerprintRetryTimer: number | null = null;

  /**
   * @param fingerprint <CompositeLogin> が収集したもの。 無ければ送信時に自前で集める。
   */
  constructor(private readonly fingerprint: DeviceFingerprint | undefined) {}

  /** 接続し、 最初の決着 (本人確認コード要求 or 認証完了) を待つ。 */
  open(wsPath: string): Promise<CompositeWsOutcome> {
    if (this.ws) throw new Error("composite WS session is already open");
    return new Promise<CompositeWsOutcome>((resolve, reject) => {
      this.waiter = { resolve, reject };
      const ws = new WebSocket(buildWsUrl(wsPath));
      this.ws = ws;
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return; // malformed frame は無視 (サーバ側 protocol 違反はログのみ)
        }
        this.handleMessage(ws, msg);
      };
      ws.onerror = () => this.fail(new Error("WebSocket 接続エラーが発生しました。"));
      ws.onclose = () => {
        this.ws = null;
        this.clearFingerprintRetry();
        this.fail(new Error("接続が切断されました。最初からやり直してください。"));
      };
    });
  }

  /** 本人確認コードを送り、 次の決着 (再チャレンジ or 認証完了) を待つ。 */
  verifyCode(code: string): Promise<CompositeWsOutcome> {
    return this.request({ type: "verify_code", code });
  }

  /** 確認コードを再送し、 challenge_pending (resent) が返るまで待つ。 */
  async resend(): Promise<void> {
    await this.request({ type: "resend" });
  }

  /** WS を閉じる。 待機中の Promise は reject する (所有者の unmount 時に必ず呼ぶ)。 */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearFingerprintRetry();
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch { /* already closing; best-effort */ }
    }
    this.fail(new Error("認証セッションを閉じました。"));
  }

  private request(payload: { type: "verify_code"; code: string } | { type: "resend" }): Promise<CompositeWsOutcome> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("接続が切断されました。最初からやり直してください。"));
    }
    if (this.waiter) {
      return Promise.reject(new Error("前の操作がまだ完了していません。"));
    }
    return new Promise<CompositeWsOutcome>((resolve, reject) => {
      this.waiter = { resolve, reject };
      ws.send(JSON.stringify(payload));
    });
  }

  private settle(outcome: CompositeWsOutcome): void {
    const w = this.waiter;
    this.waiter = null;
    w?.resolve(outcome);
  }

  private fail(err: Error): void {
    const w = this.waiter;
    this.waiter = null;
    w?.reject(err);
  }

  private sendFingerprint(ws: WebSocket): void {
    let payload: DeviceFingerprint | Record<string, never>;
    try {
      payload = this.fingerprint ?? collectDeviceFingerprint();
    } catch {
      // 収集できない環境は空で送り、 サーバに missing_fingerprint として判定させる
      // (ここで黙って止まると「ログインが進まない」 になる)。
      payload = {};
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "device", payload }));
    this.fingerprintSent = true;
  }

  /** fingerprint 収集不能時の再送を遅延・上限付きにし、サーバ応答との tight loop を防ぐ。 */
  private scheduleFingerprintRetry(ws: WebSocket): void {
    if (this.fingerprintRetryTimer !== null) return;
    if (this.fingerprintRetryCount >= MAX_FINGERPRINT_RETRIES) {
      this.fail(new Error("デバイス情報を取得できませんでした。最初からやり直してください。"));
      this.close();
      return;
    }
    this.fingerprintRetryCount += 1;
    this.fingerprintRetryTimer = window.setTimeout(() => {
      this.fingerprintRetryTimer = null;
      if (ws === this.ws && ws.readyState === WebSocket.OPEN) this.sendFingerprint(ws);
    }, FINGERPRINT_RETRY_DELAY_MS);
  }

  private clearFingerprintRetry(): void {
    if (this.fingerprintRetryTimer === null) return;
    window.clearTimeout(this.fingerprintRetryTimer);
    this.fingerprintRetryTimer = null;
  }

  private handleMessage(ws: WebSocket, msg: ServerMessage): void {
    switch (msg.type) {
      case "state":
        if (msg.state === "pending_device") {
          if (!this.fingerprintSent) this.sendFingerprint(ws);
        } else if (msg.state === "challenge_pending") {
          this.clearFingerprintRetry();
          this.fingerprintRetryCount = 0;
          this.settle({ kind: "challenge", data: msg.data ?? {} });
        } else if (msg.state === "expired") {
          this.fail(new Error("認証セッションが期限切れです。最初からやり直してください。"));
          this.close();
        }
        // "authenticated" state は直後の authenticated メッセージで authCode が届く
        return;
      case "authenticated":
        this.settle({ kind: "authenticated", authCode: msg.authCode });
        return;
      case "error":
        if (msg.retryable && msg.reason.includes("fingerprint")) {
          // fingerprint 空エラーは間隔と上限を設けて再送する。
          this.fingerprintSent = false;
          this.scheduleFingerprintRetry(ws);
          return;
        }
        this.fail(new Error(msg.reason));
        if (!msg.retryable) this.close();
        return;
      case "ping":
        try {
          ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        } catch { /* socket closing; best-effort */ }
        return;
    }
  }
}
