/**
 * Peer WS メッセージエンベロープ.
 *
 * 2 つのバックエンドサービス間の WS channel 上を流れる JSON 形式.
 * 同一 channel で invoke / response / event の 3 種類を混在させ、`id`
 * で request/response を突き合わせる.
 */

export type EnvelopeType = "invoke" | "response" | "error" | "event";

export interface InvokeEnvelope {
  id:      string;
  type:    "invoke";
  command: string;
  /** 受信側 handler に渡す任意 JSON. */
  payload: unknown;
  /** この時刻までに callee が応答しなければ caller はタイムアウト扱い (ms, Unix time). */
  deadline?: number;
}

export interface ResponseEnvelope {
  id:     string;
  type:   "response";
  /** 対応する invoke の返り値. */
  result: unknown;
}

export interface ErrorEnvelope {
  id:    string;
  type:  "error";
  error: {
    code:    string;
    message: string;
  };
}

export interface EventEnvelope {
  id:      string;
  type:    "event";
  topic:   string;
  payload: unknown;
}

export type Envelope =
  | InvokeEnvelope
  | ResponseEnvelope
  | ErrorEnvelope
  | EventEnvelope;

/** envelope を JSON 文字列に. 失敗時は "internal" error envelope で握りつぶす. */
export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify(env);
}

/** 文字列 → envelope. 妥当性を最低限チェックし、不正なら null. */
export function decodeEnvelope(raw: string): Envelope | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.type !== "string") return null;
  switch (obj.type) {
    case "invoke":
      if (typeof obj.command !== "string") return null;
      return obj as unknown as InvokeEnvelope;
    case "response":
      return obj as unknown as ResponseEnvelope;
    case "error":
      if (!obj.error || typeof obj.error !== "object") return null;
      return obj as unknown as ErrorEnvelope;
    case "event":
      if (typeof obj.topic !== "string") return null;
      return obj as unknown as EventEnvelope;
    default:
      return null;
  }
}

export class PeerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PeerError";
  }
}
