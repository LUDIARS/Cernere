/**
 * パスキーのみ認証のアカウント操作 (spec/plan/2026-10-14-passkey-only-authentication.md)。
 *
 *   signup           新しく始める (名前・メールは聞かない。名前はオンボーディングで入れる)
 *   recoveryCode     リカバリー QR の発行・状態
 *   recoveryWithCode QR から新しいパスキーを登録して 24 時間の回復待機に入る / 待機後に確定
 *   pairing          別端末の追加 (元端末で QR を出し、読んだ端末の候補を照合番号で承認する)
 */

import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "./webauthn";
import { authorizeAction } from "./action-auth";
import { getAccessToken, setTokens } from "./browser-token-store";
import { setStoredUser } from "./api";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface SessionResponse {
  user: { id: string; displayName: string | null; role: string; needsProfile?: boolean };
  accessToken: string;
  refreshToken: string;
}

async function post<T>(action: string, body: unknown, opts: { auth?: boolean; proof?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth) {
    const token = getAccessToken();
    if (!token) throw new Error("ログインが必要です");
    headers.Authorization = `Bearer ${token}`;
  }
  if (opts.proof) headers["X-Cernere-Action-Proof"] = opts.proof;
  const res = await fetch(`${API_BASE}/api/auth/passkey/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    credentials: "include",
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

function storeSession(data: SessionResponse): void {
  setTokens(data.accessToken, data.refreshToken);
  setStoredUser({ id: data.user.id, name: data.user.displayName ?? "", email: "", role: data.user.role });
}

/** 新しく始める: この端末に新しいパスキーを作り、そのままログインする。 */
export async function signupWithPasskey(): Promise<SessionResponse> {
  const begin = await post<{ signupId: string; options: PublicKeyCredentialCreationOptionsJSON }>("signup-begin", {});
  const response = await startRegistration({ optionsJSON: begin.options });
  const data = await post<SessionResponse>("signup-finish", { signupId: begin.signupId, response });
  storeSession(data);
  return data;
}

// ── リカバリー QR ────────────────────────────────────────────

export interface RecoveryStatus {
  hasActiveCode: boolean;
  canIssueWithoutProof: boolean;
  pendingRecovery: { requestId: string; createdAt: string; eligibleAt: string; device: string | null } | null;
}

export const recoveryCode = {
  status(): Promise<RecoveryStatus> {
    return post("recovery-code-status", {}, { auth: true });
  },

  /**
   * コードを発行し平文を一度だけ受け取る。作成直後・回復確定直後の初回は proof 不要、
   * それ以外 (再発行) は fresh proof を取る。
   */
  async issue(userId: string, withoutProof: boolean): Promise<{ code: string; issuedAt: string }> {
    const proof = withoutProof ? undefined : await authorizeAction("recovery_code.issue", userId);
    return post("recovery-code-issue", {}, { auth: true, proof });
  },

  /** 保留中の回復を取り消す。要求より前からある自分のパスキーで確かめる。 */
  async cancel(requestId: string): Promise<void> {
    const proof = await authorizeAction("recovery_request.cancel", requestId);
    await post("recovery-request-cancel", { requestId }, { auth: true, proof });
  },
};

export const recoveryWithCode = {
  /** QR のコードで新しいパスキーを登録し、回復待機に入る。 */
  async start(code: string): Promise<{ pending: true; eligibleAt: string }> {
    const begin = await post<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      "recovery-code-begin", { code: code.trim() });
    const response: RegistrationResponseJSON = await startRegistration({ optionsJSON: begin.options });
    return post("recovery-code-finish", { ceremonyId: begin.ceremonyId, response });
  },

  /** 待機期限を過ぎた回復を、新しいパスキーで確定してログインする。 */
  async confirm(): Promise<SessionResponse> {
    const begin = await post<{ confirmId: string; options: PublicKeyCredentialRequestOptionsJSON }>("recovery-confirm-begin", {});
    const response = await startAuthentication({ optionsJSON: begin.options });
    const data = await post<SessionResponse & { recovered: true }>("recovery-confirm-finish", { confirmId: begin.confirmId, response });
    storeSession(data);
    return data;
  },
};

// ── 別端末の追加 ─────────────────────────────────────────────

export type PairingState = "waiting" | "candidate" | "approved" | "rejected" | "expired";

export interface PairingStatus {
  pairingId: string;
  state: PairingState;
  candidateLabel?: string;
  approvalResource?: string;
}

export const pairing = {
  create(): Promise<{ pairingId: string; url: string; expiresIn: number }> {
    return post("device-link", {}, { auth: true });
  },

  status(pairingId: string): Promise<PairingStatus> {
    return post("device-pairing-status", { pairingId }, { auth: true });
  },

  /** 追加する端末に出た 4 桁を入力して、この端末の既存パスキーで承認する。 */
  async approve(status: PairingStatus, matchCode: string): Promise<void> {
    if (!status.approvalResource) throw new Error("承認できる端末がありません");
    if (!/^\d{4}$/.test(matchCode)) throw new Error("4 桁の番号を入力してください");
    const proof = await authorizeAction("passkey.pairing_approve", status.approvalResource);
    await post("device-pairing-approve", { pairingId: status.pairingId, matchCode }, { auth: true, proof });
  },

  async reject(pairingId: string): Promise<void> {
    await post("device-pairing-reject", { pairingId }, { auth: true });
  },

  /** QR を読んだ端末: token を消費して、追加先のアカウント表示と ceremony を受け取る。 */
  registerBegin(token: string): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON; account: { label: string } }> {
    return post("device-register-begin", { token });
  },

  /** QR を読んだ端末: パスキーを作り、承認待ちの照合番号を受け取る。セッションは発行されない。 */
  async registerFinish(begin: { ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }): Promise<{ pairingId: string; matchCode: string }> {
    const response = await startRegistration({ optionsJSON: begin.options });
    return post("device-register-finish", { ceremonyId: begin.ceremonyId, response });
  },
};
