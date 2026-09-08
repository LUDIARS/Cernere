/**
 * <CompositeLogin>
 *
 * サービス (Schedula 等) の SPA に埋め込んで使う Cernere 認証 UI。 Cernere 自身の
 * /login と /composite/login も同じカードを描画する (認証 UI の本流はこの SDK)。
 *
 * CORS を避けるため、実通信は利用側が提供する authApi (通常はサービス
 * バックエンドへの REST → project WS 経由) に委譲する。
 *
 * authApi に passkey 4 メソッドがあれば:
 *   - login タブ: 画面を開いた直後に usernameless パスキー ceremony を自動起動
 *   - register タブ: 「パスキーでアカウント作成」 を第一候補にし、 email は任意
 * 無ければ従来どおり email / password のみ。
 *
 * Usage (Schedula):
 *   <CompositeLogin authApi={myAuthApi} onAuthCode={(code) => ...} />
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  passkeyApiOf,
  type CompositeAuthApi,
  type CompositeAuthResponse,
  type DeviceAnomaly,
} from "./auth-api.js";
import { collectDeviceFingerprint, type DeviceFingerprint } from "./device-fingerprint.js";
import { LoginDivider } from "./LoginDivider.js";
import { DEFAULT_LABELS, type CompositeLoginLabels } from "./login-labels.js";
import {
  hintStyle,
  inputStyle,
  labelStyle,
  linkButtonStyle,
  oauthBtnStyle,
  primaryButtonStyle,
  subtleLinkStyle,
} from "./login-styles.js";
import { PasskeyLoginSection } from "./PasskeyLoginSection.js";
import { runPasskeySignup } from "./passkey-signup.js";
import { isPasskeyUserAbort, usePasskeyLogin } from "./usePasskeyLogin.js";

// 旧 import 経路 (./CompositeLogin.js からの型 import) を壊さないための再 export。
export type { CompositeAuthApi, CompositeAuthResponse, DeviceAnomaly } from "./auth-api.js";

export type CompositeLoginMode = "login" | "register";

export interface CompositeLoginProps {
  /** 認証 API 実装 (サービス側が提供) */
  authApi: CompositeAuthApi;
  /** 認証成功時のコールバック (auth_code を受け取る) */
  onAuthCode: (authCode: string) => void;
  /** OAuth ボタンを有効化する場合の設定 */
  oauth?: {
    googleUrl?: string;
    githubUrl?: string;
  };
  /** 表示テキストの上書き (i18n) */
  labels?: Partial<CompositeLoginLabels>;
  /**
   * カード内の主フォーム下に差し込む代替ログイン導線。
   * カード外に置くと主フォームと切り離されて見えるため、 利用側の導線も
   * ここから同じカードの中へ入れる。 mfa / device 確認中は出さない。
   */
  alternatives?: ReactNode;
  /** alternatives の上に出す区切り文言 (既定は orContinueWith) */
  alternativesLabel?: string;
  /** 初期タブ (既定 login) */
  initialMode?: CompositeLoginMode;
  /** タブ切替の通知 (URL 同期等に使う) */
  onModeChange?: (mode: CompositeLoginMode) => void;
  /**
   * パスワード導線を出さず、 パスキーだけで完結させる (auth_mode=passkey)。
   * authApi にパスキー API が無い構成では設定不備として例外にする。
   */
  passkeyOnly?: boolean;
  /**
   * login タブ表示時にパスキー ceremony を自動起動してよいか (既定 true)。
   * 送信先検証や silent SSO が先に決着すべき画面は、 決着後に true へ切り替える。
   */
  passkeyAutoStart?: boolean;
  /** 追加スタイル (カード外側) */
  className?: string;
  style?: CSSProperties;
}

type Mode = CompositeLoginMode | "mfa" | "device";

interface DeviceChallenge {
  deviceToken: string;
  emailMasked?: string;
  anomalies: DeviceAnomaly[];
  codeChannel?: "email" | "console";
  deviceLabel?: string;
}

function anomalyLabel(a: DeviceAnomaly, l: CompositeLoginLabels): string {
  switch (a) {
    case "new_device": return l.anomalyNewDevice;
    case "new_os": return l.anomalyNewOs;
    case "new_browser": return l.anomalyNewBrowser;
    case "new_ip": return l.anomalyNewIp;
    case "missing_fingerprint": return l.anomalyMissing;
    default: return a;
  }
}

/**
 * @implements SPEC-COMPOSITE-AUTH-ALTERNATIVES
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */
export function CompositeLogin(props: CompositeLoginProps): ReactElement {
  const l: CompositeLoginLabels = { ...DEFAULT_LABELS, ...props.labels };
  const {
    authApi,
    onAuthCode,
    oauth,
    passkeyOnly = false,
    passkeyAutoStart = true,
    onModeChange,
  } = props;

  // 一部だけ実装された passkey API は passkeyApiOf が例外にする (無言故障防止)。
  const passkeyApi = useMemo(() => passkeyApiOf(authApi), [authApi]);
  if (passkeyOnly && !passkeyApi) {
    throw new Error("CompositeLogin: passkeyOnly requires authApi.passkey* methods");
  }
  const showPasswordFields = !passkeyOnly;

  const [mode, setModeState] = useState<Mode>(props.initialMode ?? "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [mfaMethod, setMfaMethod] = useState("totp");
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [mfaCode, setMfaCode] = useState("");
  const [device, setDevice] = useState<DeviceChallenge | null>(null);
  const [deviceCode, setDeviceCode] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const switchMode = (next: CompositeLoginMode) => {
    setMfaToken("");
    setMfaCode("");
    setMfaMethods([]);
    setModeState(next);
    setError("");
    setInfo("");
    onModeChange?.(next);
  };

  // ── マウント時にフィンガープリント収集 (machine + browser のみ、同期) ──
  // passkey 専用モードは本人属性を集めない (パスキー既定設計 §6.2)。
  const [fingerprint, setFingerprint] = useState<DeviceFingerprint | null>(null);
  useEffect(() => {
    if (passkeyOnly) return;
    try {
      setFingerprint(collectDeviceFingerprint());
    } catch {
      setFingerprint(null);
    }
  }, [passkeyOnly]);

  const handleResponse = (r: CompositeAuthResponse) => {
    setInfo("");
    if (r.mfaRequired) {
      if (!r.mfaToken || !r.mfaMethods?.length) throw new Error("Invalid MFA challenge response");
      setPassword("");
      setMfaCode("");
      setMfaToken(r.mfaToken);
      setMfaMethods(r.mfaMethods);
      setMfaMethod(r.mfaMethods[0] ?? "totp");
      setModeState("mfa");
      return;
    }
    if (r.deviceVerificationRequired && r.deviceToken) {
      setDevice({
        deviceToken: r.deviceToken,
        emailMasked: r.emailMasked,
        anomalies: r.anomalies ?? [],
        codeChannel: r.codeChannel,
        deviceLabel: r.deviceLabel,
      });
      setDeviceCode("");
      setModeState("device");
      return;
    }
    if (r.authCode) {
      onAuthCode(r.authCode);
    }
  };

  // ── login タブを開いた直後に認証器ダイアログを開く (1 マウント 1 回) ──
  const passkey = usePasskeyLogin({
    api: passkeyApi,
    autoStartReady: passkeyAutoStart && mode === "login",
    onResponse: handleResponse,
    onError: setError,
  });
  const passkeyBusy = passkey.phase === "running";

  const submitDeviceVerify = async () => {
    if (!authApi.deviceVerify || !device) {
      throw new Error("Device verification is not supported");
    }
    const r = await authApi.deviceVerify({ deviceToken: device.deviceToken, code: deviceCode.trim() });
    if (r.error) {
      const remaining = typeof r.remainingAttempts === "number"
        ? l.remainingAttempts.replace("{n}", String(r.remainingAttempts))
        : "";
      throw new Error(remaining ? `${r.error} (${remaining})` : r.error);
    }
    handleResponse(r);
  };

  const handleResend = async () => {
    if (!authApi.deviceResend || !device) return;
    setError("");
    setInfo("");
    setLoading(true);
    try {
      await authApi.deviceResend({ deviceToken: device.deviceToken });
      setInfo(l.deviceResent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resend failed");
    } finally {
      setLoading(false);
    }
  };

  /** メアド不要のパスキー新規登録 (Windows Hello / Face ID / Android 生体)。 */
  const handlePasskeySignup = async () => {
    if (!passkeyApi) return;
    setError("");
    setInfo("");
    if (!name.trim()) {
      setError(l.nameRequired);
      return;
    }
    setLoading(true);
    try {
      handleResponse(await runPasskeySignup(passkeyApi, { name, email }));
    } catch (err: unknown) {
      // ダイアログを閉じただけなら「失敗」 と言わない。
      if (!isPasskeyUserAbort(err)) {
        setError(err instanceof Error ? err.message : "Passkey registration failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    // パスキー導線がある構成では email/password は任意入力なので、 パスワード登録の
    // 必須条件はここで検査する (required 属性に頼らない)。
    if (mode === "register" && passkeyApi && (!email.trim() || !password)) {
      setError(l.registerPasswordRequires);
      return;
    }
    setLoading(true);
    try {
      const fp = fingerprint ?? undefined;
      if (mode === "login") {
        handleResponse(await authApi.login({ email, password, device: fp }));
      } else if (mode === "register") {
        handleResponse(await authApi.register({ name, email, password, device: fp }));
      } else if (mode === "mfa") {
        if (!authApi.mfaVerify) throw new Error("MFA is not supported");
        handleResponse(await authApi.mfaVerify({ mfaToken, method: mfaMethod, code: mfaCode, device: fp }));
      } else if (mode === "device") {
        await submitDeviceVerify();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const isAuthTab = mode === "login" || mode === "register";
  const busy = loading || passkeyBusy;
  // passkey 専用の register / login はパスワード送信ボタンを持たない。
  const showSubmit = !isAuthTab || showPasswordFields;
  const submitLabel = loading
    ? l.processing
    : mode === "login"
      ? l.submitLogin
      : mode === "register"
        ? (passkeyApi ? l.submitRegisterPassword : l.submitRegister)
        : mode === "device"
          ? l.deviceSubmit
          : l.submitMfa;

  return (
    <div
      className={props.className}
      style={{
        width: "100%",
        maxWidth: 400,
        background: "var(--bg-surface, #fff)",
        border: "1px solid var(--border, #ccc)",
        borderRadius: "var(--radius, 8px)",
        padding: "2rem",
        boxSizing: "border-box",
        ...props.style,
      }}
    >
      <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>{l.title}</h1>
        <p style={{ color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>
          {mode === "device" ? l.deviceTitle : passkeyOnly ? l.subtitlePasskeyOnly : l.subtitle}
        </p>
      </div>

      {isAuthTab && !passkeyOnly && (
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid var(--border, #ccc)",
            marginBottom: "1.5rem",
          }}
        >
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              style={{
                flex: 1,
                padding: "0.5rem",
                background: "transparent",
                border: "none",
                borderBottom: mode === m ? "2px solid var(--accent, #4f46e5)" : "2px solid transparent",
                color: mode === m ? "var(--text, #000)" : "var(--text-muted, #888)",
                fontWeight: mode === m ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {m === "login" ? l.loginTab : l.registerTab}
            </button>
          ))}
        </div>
      )}

      {info && (
        <div
          style={{
            background: "rgba(34, 197, 94, 0.1)",
            border: "1px solid var(--green, #22c55e)",
            borderRadius: "4px",
            padding: "0.5rem 0.75rem",
            marginBottom: "1rem",
            fontSize: "0.85rem",
            color: "var(--green, #16a34a)",
          }}
        >
          {info}
        </div>
      )}

      {error && (
        <div
          style={{
            background: "rgba(248, 81, 73, 0.1)",
            border: "1px solid var(--red, #ef4444)",
            borderRadius: "4px",
            padding: "0.5rem 0.75rem",
            marginBottom: "1rem",
            fontSize: "0.85rem",
            color: "var(--red, #ef4444)",
          }}
        >
          {error}
        </div>
      )}

      {/* login: パスキーが主導線。 画面を開いた時点で自動起動済みなので、 ここは再試行。 */}
      {mode === "login" && passkeyApi && (
        <>
          <PasskeyLoginSection
            phase={passkey.phase}
            hasAttempted={passkey.hasAttempted}
            disabled={loading}
            passkeyOnly={passkeyOnly}
            hasError={Boolean(error)}
            onStart={() => { setError(""); setInfo(""); passkey.start(email); }}
            labels={l}
          />
          {passkeyOnly && (
            <div style={{ textAlign: "center", marginTop: "0.75rem" }}>
              <button type="button" onClick={() => switchMode("register")} style={subtleLinkStyle}>
                {l.noAccountYet}
              </button>
            </div>
          )}
          {showPasswordFields && <LoginDivider label={l.orContinueWith} />}
        </>
      )}

      <form onSubmit={handleSubmit}>
        {mode === "register" && (
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>{l.name}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={l.name}
              autoComplete="name"
              required
              style={inputStyle}
            />
          </div>
        )}

        {/* register: メアド不要のパスキー登録を第一候補に置く。 */}
        {mode === "register" && passkeyApi && (
          <>
            <button
              type="button"
              onClick={() => { void handlePasskeySignup(); }}
              disabled={busy}
              style={{ ...primaryButtonStyle(busy), marginTop: 0 }}
            >
              {loading ? l.processing : l.passkeySignup}
            </button>
            <p style={{ ...hintStyle, marginTop: "0.5rem", textAlign: "center" }}>{l.passkeySignupHint}</p>
            {passkeyOnly && (
              <div style={{ textAlign: "center", marginTop: "0.25rem" }}>
                <button type="button" onClick={() => switchMode("login")} style={subtleLinkStyle}>
                  {l.alreadyHaveAccount}
                </button>
              </div>
            )}
            {showPasswordFields && <LoginDivider label={l.orUsePassword} />}
          </>
        )}

        {isAuthTab && showPasswordFields && (
          <>
            <div style={{ marginBottom: "0.75rem" }}>
              <label style={labelStyle}>
                {mode === "register" && passkeyApi ? l.emailOptional : l.email}
              </label>
              <input
                type="email"
                name="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required={!(mode === "register" && passkeyApi)}
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: "0.75rem" }}>
              <label style={labelStyle}>
                {mode === "register" && passkeyApi ? l.passwordOptional : l.password}
              </label>
              <input
                type="password"
                name="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8+ characters"
                minLength={8}
                required={!(mode === "register" && passkeyApi)}
                style={inputStyle}
              />
            </div>
          </>
        )}

        {mode === "mfa" && (
          <div style={{ marginBottom: "0.75rem" }}>
            <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>{l.mfaTitle}</p>
            <label style={labelStyle}>{l.mfaMethod}
              <select value={mfaMethod} disabled={loading} style={inputStyle} onChange={(event) => { setMfaMethod(event.target.value); setMfaCode(""); setInfo(""); setError(""); }}>
                {mfaMethods.map((method) => <option key={method} value={method}>{method === "totp" ? l.mfaTotp : method === "email" ? l.mfaEmail : method}</option>)}
              </select>
            </label>
            {mfaMethod === "email" && <button type="button" disabled={loading || !authApi.mfaSendCode} onClick={async () => {
              if (!authApi.mfaSendCode) return;
              setLoading(true); setError(""); setInfo("");
              try { await authApi.mfaSendCode({ mfaToken, method: mfaMethod }); setInfo(l.mfaSent); }
              catch (err) { setError(err instanceof Error ? err.message : "MFA code delivery failed"); }
              finally { setLoading(false); }
            }}>{l.mfaSend}</button>}
            <p style={hintStyle}>{l.mfaHint}</p>
            <label style={labelStyle}>{l.mfaCode}</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              disabled={loading}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              placeholder="123456"
              required
              style={inputStyle}
              autoFocus
            />
            <button type="button" disabled={loading} onClick={() => switchMode("login")}>{l.mfaCancel}</button>
          </div>
        )}

        {mode === "device" && device && (
          <div style={{ marginBottom: "0.75rem" }}>
            <p style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.25rem" }}>{l.deviceTitle}</p>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)", marginBottom: "0.75rem" }}>
              {l.deviceSubtitle.replace("{email}", device.emailMasked ?? l.email)}
            </p>

            {device.deviceLabel && (
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted, #888)", marginBottom: "0.5rem" }}>
                <strong>Device:</strong> {device.deviceLabel}
              </p>
            )}

            {device.anomalies.length > 0 && (
              <div style={{ marginBottom: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                {device.anomalies.map((a) => (
                  <span
                    key={a}
                    style={{
                      fontSize: "0.7rem",
                      padding: "0.15rem 0.5rem",
                      borderRadius: "999px",
                      background: "rgba(245, 158, 11, 0.15)",
                      border: "1px solid var(--amber, #f59e0b)",
                      color: "var(--amber, #b45309)",
                    }}
                  >
                    {anomalyLabel(a, l)}
                  </span>
                ))}
              </div>
            )}

            <label style={labelStyle}>{l.deviceCode}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              value={deviceCode}
              onChange={(e) => setDeviceCode(e.target.value.replace(/\D/g, ""))}
              placeholder={l.deviceCodePlaceholder}
              required
              style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: "0.25em", textAlign: "center", fontSize: "1.1rem" }}
              autoFocus
            />
          </div>
        )}

        {showSubmit && (
          <button type="submit" disabled={busy} style={primaryButtonStyle(busy)}>
            {submitLabel}
          </button>
        )}

        {mode === "device" && authApi.deviceResend && (
          <button
            type="button"
            onClick={() => { void handleResend(); }}
            disabled={loading}
            style={linkButtonStyle(loading)}
          >
            {l.deviceResend}
          </button>
        )}

        {isAuthTab && showPasswordFields && !fingerprint && (
          <p style={{ fontSize: "0.7rem", color: "var(--text-muted, #888)", marginTop: "0.5rem", textAlign: "center" }}>
            {l.collectingFingerprint}
          </p>
        )}
      </form>

      {isAuthTab && !passkeyOnly && oauth && (oauth.googleUrl || oauth.githubUrl) && (
        <>
          <LoginDivider label={l.orContinueWith} />

          {oauth.googleUrl && (
            <a href={oauth.googleUrl} style={oauthBtnStyle}>
              {l.continueWithGoogle}
            </a>
          )}
          {oauth.githubUrl && (
            <a href={oauth.githubUrl} style={{ ...oauthBtnStyle, marginTop: "0.5rem" }}>
              {l.continueWithGithub}
            </a>
          )}
        </>
      )}

      {isAuthTab && props.alternatives && (
        <>
          <LoginDivider label={props.alternativesLabel ?? l.orContinueWith} />
          {props.alternatives}
        </>
      )}
    </div>
  );
}
