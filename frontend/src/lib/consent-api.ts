/**
 * サービスの権限確認 (同意) の API。
 *
 * /consent 画面 (ログイン途中) は REST + consentTicket、/data-optout「サービスの権限」(利用開始後の
 * 見直し) は WS module "consent" を使う。表示データの形はサーバの consent/requirement.ts と同じ。
 */

import { getAccessToken } from "./browser-token-store";
import { wsClient } from "./ws-client";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type ConsentAudience = "self" | "service_users" | "public" | "other_services";

export interface ConsentAudienceView {
  audience: ConsentAudience;
  /** service = サービスの申告 / cernere = Cernere が渡している確定情報 */
  source: "service" | "cernere";
  services?: string[];
}

export interface ConsentPermissionView {
  key: string;
  kind: "identity" | "profile" | "identity_claim" | "user_data" | "oidc";
  level: "required" | "recommended";
  purpose: string | null;
  visibleTo: ConsentAudienceView[];
  sharedBeyondSelf: boolean;
  privacyDependent: boolean;
  isNew: boolean;
  decision: "granted" | "denied" | null;
}

export interface ConsentView {
  version: number;
  declared: boolean;
  reconsent: boolean;
  required: ConsentPermissionView[];
  recommended: ConsentPermissionView[];
}

export interface ConsentTicketInfo {
  serviceName: string;
  subjectKind: "project" | "oidc_client";
  view: ConsentView;
  satisfied: boolean;
}

export type ConsentOutcome =
  | { kind: "post_message"; origin: string; message: { type: "cernere:auth"; authCode?: string; error?: "consent_denied" } }
  | { kind: "redirect"; url: string }
  | { kind: "none" };

/** API のエラー。code で「Cernere へのログインが要る」等を見分ける。 */
export class ConsentApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "ConsentApiError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!res.ok) throw new ConsentApiError(data.error ?? "Request failed", data.code, res.status);
  return data;
}

export const consentTicketApi = {
  get(ticket: string): Promise<ConsentTicketInfo> {
    return call(`/api/consent/ticket?ticket=${encodeURIComponent(ticket)}`);
  },
  decide(ticket: string, decision: "grant" | "deny", recommended: string[]): Promise<ConsentOutcome> {
    return call("/api/consent/decide", { method: "POST", body: JSON.stringify({ ticket, decision, recommended }) });
  },
};

export interface ServiceConsentItem {
  subjectKind: "project" | "oidc_client";
  subjectKey: string;
  serviceName: string;
  mode: "off" | "warn" | "enforce";
  decidedAt: string | null;
  revokedAt: string | null;
  satisfied: boolean;
  view: ConsentView;
}

export const serviceConsents = {
  list(): Promise<ServiceConsentItem[]> {
    return wsClient.sendCommand<ServiceConsentItem[]>("consent", "list");
  },
  /** 推奨の許可を変える。ws-client が action proof (consent.decide) を取る。 */
  decide(item: Pick<ServiceConsentItem, "subjectKind" | "subjectKey">, recommended: string[]): Promise<ServiceConsentItem> {
    return wsClient.sendCommand<ServiceConsentItem>("consent", "decide", {
      subjectKind: item.subjectKind, subjectKey: item.subjectKey, recommended,
    });
  },
  /** 同意を取り消す (= そのサービスの利用停止)。 */
  revoke(item: Pick<ServiceConsentItem, "subjectKind" | "subjectKey">): Promise<ServiceConsentItem> {
    return wsClient.sendCommand<ServiceConsentItem>("consent", "revoke", {
      subjectKind: item.subjectKind, subjectKey: item.subjectKey,
    });
  },
};

/** 同意の結果を継続先へ渡す。渡し先が無ければ false (画面が案内を出す)。 */
export function deliverConsentOutcome(outcome: ConsentOutcome): boolean {
  if (outcome.kind === "redirect") {
    window.location.href = outcome.url;
    return true;
  }
  if (outcome.kind === "post_message" && window.opener) {
    (window.opener as Window).postMessage(outcome.message, outcome.origin);
    window.close();
    return true;
  }
  return false;
}
