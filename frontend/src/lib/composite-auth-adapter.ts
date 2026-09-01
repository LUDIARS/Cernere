/**
 * Cernere 自身のフロントが <CompositeLogin> (埋め込み SDK) に渡す authApi 実装。
 *
 * 他サービスは自分の backend → project WS 経由で Cernere を叩くが、 Cernere の
 * /login と /composite/login は同一 origin なので REST を直接呼ぶ:
 *   - password: POST /api/auth/composite/{login,register} → composite WS で本人確認
 *   - passkey : POST /api/auth/passkey/{login-begin, composite-login-finish,
 *                                       signup-begin, composite-signup-finish}
 * どちらも最終的に authCode を返し、 ページ側が self exchange / postMessage / redirect
 * のいずれかで引き渡す。
 */

import type {
  CompositeAuthApi,
  CompositeAuthResponse,
  DeviceFingerprint,
  PasskeyLoginBeginResult,
  PasskeySignupBeginResult,
} from "@ludiars/cernere-composite/ui";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { CompositeWsSession, type CompositeWsOutcome } from "./composite-ws-session";

interface CompositeLoginResponse {
  ticket?: string;
  wsPath?: string;
  mfaRequired?: boolean;
  error?: string;
}

/**
 * composite WS の本人確認はセッション (WS 接続) に紐づき、 SDK が持ち回る
 * deviceToken は使わない。 SDK は deviceToken が truthy のときだけ device 画面へ
 * 遷移するため、 接続識別のプレースホルダを入れる。
 */
const WS_BOUND_DEVICE_TOKEN = "composite-ws";

async function postJson<T>(url: string, body: unknown, fallbackError: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallbackError);
  return data;
}

function outcomeToResponse(outcome: CompositeWsOutcome): CompositeAuthResponse {
  if (outcome.kind === "authenticated") return { authCode: outcome.authCode };
  const d = outcome.data;
  return {
    deviceVerificationRequired: true,
    deviceToken: d.deviceToken ?? WS_BOUND_DEVICE_TOKEN,
    emailMasked: d.emailMasked,
    anomalies: d.anomalies,
    codeChannel: d.codeChannel,
    deviceLabel: d.deviceLabel,
    error: d.error,
    remainingAttempts: d.remainingAttempts,
  };
}

export class CernereCompositeAuthAdapter implements CompositeAuthApi {
  private session: CompositeWsSession | null = null;

  constructor(private readonly apiBase: string = "") {}

  // ── password 経路 ─────────────────────────────────────────

  async login(params: { email: string; password: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse> {
    const { email, password, device } = params;
    return this.startPasswordFlow("login", { email, password }, device);
  }

  async register(params: { name: string; email?: string; password?: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse> {
    const { name, email, password, device } = params;
    // パスキー登録は passkeySignup* に流れるので、 ここに来るのはパスワード登録だけ。
    if (!email || !password) {
      throw new Error("パスワード登録にはメールアドレスとパスワードが必要です (パスキーなら名前だけで登録できます)");
    }
    return this.startPasswordFlow("register", { name, email, password }, device);
  }

  async deviceVerify(params: { deviceToken: string; code: string }): Promise<CompositeAuthResponse> {
    const session = this.requireSession();
    const outcome = await session.verifyCode(params.code);
    const response = outcomeToResponse(outcome);
    if (response.authCode) this.disposeSession();
    return response;
  }

  async deviceResend(): Promise<CompositeAuthResponse> {
    await this.requireSession().resend();
    return {};
  }

  // ── passkey 経路 ──────────────────────────────────────────

  passkeyLoginBegin(params: { email?: string }): Promise<PasskeyLoginBeginResult> {
    return postJson(`${this.apiBase}/api/auth/passkey/login-begin`,
      { email: params.email ?? "" }, "Passkey login start failed");
  }

  async passkeyLoginFinish(params: { challengeOwner: string; response: AuthenticationResponseJSON }): Promise<CompositeAuthResponse> {
    const data = await postJson<{ authCode?: string }>(
      `${this.apiBase}/api/auth/passkey/composite-login-finish`, params, "Passkey login failed");
    if (!data.authCode) throw new Error("Passkey login failed");
    return { authCode: data.authCode };
  }

  passkeySignupBegin(params: { name: string; email?: string }): Promise<PasskeySignupBeginResult> {
    return postJson(`${this.apiBase}/api/auth/passkey/signup-begin`,
      params.email ? params : { name: params.name }, "Passkey registration failed");
  }

  async passkeySignupFinish(params: { signupId: string; response: RegistrationResponseJSON }): Promise<CompositeAuthResponse> {
    const data = await postJson<{ authCode?: string }>(
      `${this.apiBase}/api/auth/passkey/composite-signup-finish`, params, "Passkey registration failed");
    if (!data.authCode) throw new Error("Passkey registration failed");
    return { authCode: data.authCode };
  }

  // ── 寿命 ──────────────────────────────────────────────────

  /** ページ unmount 時に呼ぶ。 進行中の WS を閉じる。 */
  dispose(): void {
    this.disposeSession();
  }

  private async startPasswordFlow(
    action: "login" | "register",
    body: Record<string, string>,
    device: DeviceFingerprint | undefined,
  ): Promise<CompositeAuthResponse> {
    const data = await postJson<CompositeLoginResponse>(
      `${this.apiBase}/api/auth/composite/${action}`, body, "Authentication failed");
    if (data.mfaRequired) {
      throw new Error("MFA is required but not yet supported in composite mode.");
    }
    if (!data.wsPath) throw new Error("Missing wsPath in login response");

    // やり直し (前回の WS が残っている) は先に閉じてから張り直す。
    this.disposeSession();
    const session = new CompositeWsSession(device);
    this.session = session;
    try {
      const outcome = await session.open(data.wsPath);
      const response = outcomeToResponse(outcome);
      if (response.authCode) this.disposeSession();
      return response;
    } catch (err) {
      this.disposeSession();
      throw err;
    }
  }

  private requireSession(): CompositeWsSession {
    if (!this.session) {
      throw new Error("接続が切断されました。最初からやり直してください。");
    }
    return this.session;
  }

  private disposeSession(): void {
    const s = this.session;
    this.session = null;
    s?.close();
  }
}
