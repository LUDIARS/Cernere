/**
 * アカウント連携 (引き継ぎメニュー) の API (spec/plan/2026-10-15-account-federation-design.md §4)。
 *
 *   device 側   この端末を連携に加える (新しい端末 B は未ログイン、既存アカウント C はログイン済み)
 *   approver 側 使っている端末 A で連携へ迎える (パスキーで承認)
 *   設定        連携の一覧・主の切替・外す
 */

import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "./webauthn";
import { authorizeAction } from "./action-auth";
import { getAccessToken, setTokens } from "./browser-token-store";
import { setStoredUser } from "./api";

export { joinUrlKind, readJoinToken } from "./federation-qr";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type JoinState = "open" | "claimed" | "approved" | "completed" | "locked";
export type JoinKind = "new_device" | "existing_account";

export interface ServiceUsage {
  kind: "project" | "oidc_client";
  key: string;
  name: string;
}

export interface ApproverView {
  requestId: string;
  state: JoinState;
  kind: JoinKind | null;
  device: string | null;
  expiresIn: number;
  joinerServices: ServiceUsage[];
  approvalResource: string;
}

export interface DeviceTicket {
  requestId: string;
  code: string;
  deviceSecret: string;
  expiresIn: number;
}

export interface FederationMember {
  userId: string;
  displayName: string;
  joinedVia: string;
  joinedAt: string;
  isPrimary: boolean;
  isSelf: boolean;
  isFounder: boolean;
  passkeyCount: number;
}

export interface FederationView {
  federationId: string | null;
  subjectId: string;
  primaryUserId: string;
  revision: number;
  members: FederationMember[];
}

async function post<T>(action: string, body: unknown, opts: { auth?: "required" | "optional"; proof?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = opts.auth ? getAccessToken() : null;
  if (opts.auth === "required" && !token) throw new Error("ログインが必要です");
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.proof) headers["X-Cernere-Action-Proof"] = opts.proof;
  const res = await fetch(`${API_BASE}/api/federation/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!res.ok) {
    const err = new Error(data.error ?? "操作に失敗しました") as Error & { code?: string; status?: number };
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const federationDevice = {
  /** この端末で引き継ぎ要求を作る (ログインしていれば既存アカウントとして加わる)。 */
  createRequest(): Promise<DeviceTicket & { approveUrl: string }> {
    return post("request-create", {}, { auth: "optional" });
  },

  /** 使っている端末が出した招待 QR を読む。4 桁はこちらに出る。 */
  claimInvite(token: string): Promise<DeviceTicket & { kind: JoinKind }> {
    return post("invite-claim", { token }, { auth: "optional" });
  },

  status(ticket: Pick<DeviceTicket, "requestId" | "deviceSecret">): Promise<{ state: JoinState; kind: JoinKind | null; expiresIn: number }> {
    return post("request-status", { requestId: ticket.requestId, deviceSecret: ticket.deviceSecret });
  },

  /** 新しい端末: 承認済みの要求で、この端末にパスキーを作りアカウントを作って連携に加わる。 */
  async completeAsNewDevice(ticket: Pick<DeviceTicket, "requestId" | "deviceSecret">): Promise<void> {
    const begin = await passkeyPost<{ signupId: string; options: PublicKeyCredentialCreationOptionsJSON }>("signup-begin", {});
    const response = await startRegistration({ optionsJSON: begin.options });
    const data = await passkeyPost<{
      user: { id: string; displayName: string | null; role: string };
      accessToken: string; refreshToken: string;
    }>("signup-finish", {
      signupId: begin.signupId, response,
      federation: { requestId: ticket.requestId, deviceSecret: ticket.deviceSecret },
    });
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser({ id: data.user.id, name: data.user.displayName ?? "", email: "", role: data.user.role });
  },

  /** 既存アカウント: 承認済みの要求で、このアカウントのパスキーで本人確認して連携に加わる (§4.2)。 */
  async completeAsExistingAccount(ticket: Pick<DeviceTicket, "requestId" | "deviceSecret">): Promise<FederationView> {
    const proof = await authorizeAction("federation.join", ticket.requestId);
    return post("join-complete", { requestId: ticket.requestId, deviceSecret: ticket.deviceSecret }, { auth: "required", proof });
  },

  /** 既存アカウント: このアカウントで使っていたサービス (連携後は見えなくなる)。 */
  async myServices(): Promise<ServiceUsage[]> {
    return (await post<{ services: ServiceUsage[] }>("my-services", {}, { auth: "required" })).services;
  },
};

export const federationApprover = {
  /** 招待 QR を出す (読む側の端末が 4 桁を表示する)。 */
  createInvite(): Promise<{ requestId: string; joinUrl: string; expiresIn: number }> {
    return post("invite-create", {}, { auth: "required" });
  },

  /** 新しい端末が出した QR を読んだ。 */
  claim(token: string): Promise<ApproverView> {
    return post("request-claim", { token }, { auth: "required" });
  },

  describe(requestId: string): Promise<ApproverView> {
    return post("request-describe", { requestId }, { auth: "required" });
  },

  /** 相手の端末に出た 4 桁を入れ、この端末のパスキーで承認する。 */
  async approve(view: ApproverView, code: string): Promise<ApproverView> {
    if (!/^\d{4}$/.test(code)) throw new Error("4 桁の番号を入力してください");
    const proof = await authorizeAction("federation.approve", view.approvalResource);
    return post("request-approve", { requestId: view.requestId, code }, { auth: "required", proof });
  },
};

export const federationSettings = {
  describe(): Promise<FederationView> {
    return post("describe", {}, { auth: "required" });
  },

  /** 主を切り替える (今の主のパスキーで承認)。 */
  async setPrimary(view: FederationView, userId: string): Promise<FederationView> {
    if (!view.federationId) throw new Error("連携していません");
    const proof = await authorizeAction("federation.set_primary", view.federationId);
    return post("set-primary", { userId, expectedRevision: view.revision }, { auth: "required", proof });
  },

  /** 連携から外す (主による取り外し / 本人の離脱)。 */
  async remove(view: FederationView, userId: string): Promise<FederationView> {
    if (!view.federationId) throw new Error("連携していません");
    const proof = await authorizeAction("federation.remove", `${view.federationId}:${userId}`);
    return post("remove", { userId, expectedRevision: view.revision }, { auth: "required", proof });
  },
};

async function passkeyPost<T>(action: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/auth/passkey/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "パスキーの作成に失敗しました");
  return data;
}

/** 連携に関するエラーを利用者向けの文に直す。 */
export function federationErrorMessage(error: unknown): string {
  const err = error as Error & { code?: string; name?: string };
  if (err.name === "NotAllowedError" || err.name === "AbortError") return "パスキーの操作が完了しませんでした。もう一度お試しください。";
  switch (err.code) {
    case "federation_join_expired": return "引き継ぎの期限が切れました (10 分)。最初からやり直してください。";
    case "federation_join_code_mismatch": return "番号が一致しません。相手の端末に出ている 4 桁を確かめてください。";
    case "federation_join_code_locked": return "番号を 3 回間違えたため、この引き継ぎは無効になりました。最初からやり直してください。";
    case "federation_join_refused": return `連携できません: ${err.message}`;
    case "federation_revision_conflict": return "別の端末で連携が変更されました。読み直してからもう一度お試しください。";
    default: return err.message;
  }
}
