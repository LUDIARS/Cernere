/**
 * <CompositeLogin>
 *
 * サービス (Schedula 等) の SPA に埋め込んで使う Cernere 認証 UI。
 * CORS を避けるため、実通信は利用側が提供する authApi (通常はサービス
 * バックエンドへの REST → project WS 経由) に委譲する。
 *
 * Usage (Schedula):
 *   <CompositeLogin authApi={myAuthApi} onAuthCode={(code) => ...} />
 */

import { useEffect, useState } from "react";
import { collectDeviceFingerprint, type DeviceFingerprint } from "./device-fingerprint.js";

export type DeviceAnomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
  | "new_ip"
  | "missing_fingerprint";

export interface CompositeAuthResponse {
  authCode?: string;
  mfaRequired?: boolean;
  mfaMethods?: string[];
  mfaToken?: string;
  /** 本人確認 (デバイス検証) が必要 */
  deviceVerificationRequired?: boolean;
  deviceToken?: string;
  /** 確認コード送信先のマスクされたメール (例: u***@example.com) */
  emailMasked?: string;
  /** 検出された差分の一覧 */
  anomalies?: DeviceAnomaly[];
  /** 確認コードの送信チャネル */
  codeChannel?: "email" | "console";
  /** デバイスラベル (例: "macOS · Chrome 124 · Tokyo, JP") */
  deviceLabel?: string;
  /** 残り試行回数 (失敗応答時) */
  remainingAttempts?: number;
  error?: string;
}

export interface CompositeAuthApi {
  /** Email / パスワードでログイン (device は本人確認用フィンガープリント) */
  login(params: { email: string; password: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse>;
  /** 新規ユーザー登録 */
  register(params: { name: string; email: string; password: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse>;
  /** MFA チャレンジ応答 (任意) */
  mfaVerify?(params: { mfaToken: string; method: string; code: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse>;
  /** デバイス本人確認: 確認コードを検証し authCode を取得する */
  deviceVerify?(params: { deviceToken: string; code: string }): Promise<CompositeAuthResponse>;
  /** 確認コードを再送する */
  deviceResend?(params: { deviceToken: string }): Promise<CompositeAuthResponse>;
}

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
  labels?: Partial<Labels>;
  /** 追加スタイル (カード外側) */
  className?: string;
  style?: React.CSSProperties;
}

interface Labels {
  title: string;
  subtitle: string;
  loginTab: string;
  registerTab: string;
  name: string;
  email: string;
  password: string;
  submitLogin: string;
  submitRegister: string;
  processing: string;
  orContinueWith: string;
  continueWithGoogle: string;
  continueWithGithub: string;
  mfaTitle: string;
  mfaCode: string;
  submitMfa: string;
  // ── デバイス本人確認 ──────────────
  deviceTitle: string;
  deviceSubtitle: string;
  deviceCode: string;
  deviceCodePlaceholder: string;
  deviceSubmit: string;
  deviceResend: string;
  deviceResent: string;
  collectingFingerprint: string;
  anomalyNewDevice: string;
  anomalyNewOs: string;
  anomalyNewBrowser: string;
  anomalyNewIp: string;
  anomalyMissing: string;
  remainingAttempts: string;
}

const DEFAULT_LABELS: Labels = {
  title: "Cernere",
  subtitle: "Sign in to continue",
  loginTab: "Login",
  registerTab: "Register",
  name: "Name",
  email: "Email",
  password: "Password",
  submitLogin: "Login",
  submitRegister: "Create Account",
  processing: "Processing...",
  orContinueWith: "or",
  continueWithGoogle: "Continue with Google",
  continueWithGithub: "Continue with GitHub",
  mfaTitle: "MFA Verification",
  mfaCode: "Code",
  submitMfa: "Verify",
  deviceTitle: "Verify it's you",
  deviceSubtitle: "We sent a 6-digit verification code to {email}.",
  deviceCode: "Verification code",
  deviceCodePlaceholder: "123456",
  deviceSubmit: "Verify device",
  deviceResend: "Resend code",
  deviceResent: "Code re-sent.",
  collectingFingerprint: "Collecting device information...",
  anomalyNewDevice: "New device",
  anomalyNewOs: "New OS",
  anomalyNewBrowser: "New browser",
  anomalyNewIp: "Different network",
  anomalyMissing: "Could not collect device information",
  remainingAttempts: "{n} attempts remaining",
};

type Mode = "login" | "register" | "mfa" | "device";

interface DeviceChallenge {
  deviceToken: string;
  emailMasked?: string;
  anomalies: DeviceAnomaly[];
  codeChannel?: "email" | "console";
  deviceLabel?: string;
}

function anomalyLabel(a: DeviceAnomaly, l: Labels): string {
  switch (a) {
    case "new_device": return l.anomalyNewDevice;
    case "new_os": return l.anomalyNewOs;
    case "new_browser": return l.anomalyNewBrowser;
    case "new_ip": return l.anomalyNewIp;
    case "missing_fingerprint": return l.anomalyMissing;
    default: return a;
  }
}

export function CompositeLogin(props: CompositeLoginProps) {
  const l: Labels = { ...DEFAULT_LABELS, ...props.labels };
  const { authApi, onAuthCode, oauth } = props;

  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [mfaMethod, setMfaMethod] = useState("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [device, setDevice] = useState<DeviceChallenge | null>(null);
  const [deviceCode, setDeviceCode] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // ── マウント時にフィンガープリント収集 (machine + browser のみ、同期) ──
  const [fingerprint, setFingerprint] = useState<DeviceFingerprint | null>(null);
  useEffect(() => {
    try {
      setFingerprint(collectDeviceFingerprint());
    } catch {
      setFingerprint(null);
    }
  }, []);

  const handleResponse = (r: CompositeAuthResponse) => {
    setInfo("");
    if (r.mfaRequired) {
      setMfaToken(r.mfaToken ?? "");
      setMfaMethod(r.mfaMethods?.[0] ?? "totp");
      setMode("mfa");
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
      setMode("device");
      return;
    }
    if (r.authCode) {
      onAuthCode(r.authCode);
    }
  };

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
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
        <p style={{ color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>{l.subtitle}</p>
      </div>

      {mode !== "mfa" && mode !== "device" && (
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
              onClick={() => { setMode(m); setError(""); }}
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

      <form onSubmit={handleSubmit}>
        {mode === "register" && (
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>{l.name}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={l.name}
              required
              style={inputStyle}
            />
          </div>
        )}

        {(mode === "login" || mode === "register") && (
          <>
            <div style={{ marginBottom: "0.75rem" }}>
              <label style={labelStyle}>{l.email}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: "0.75rem" }}>
              <label style={labelStyle}>{l.password}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8+ characters"
                minLength={8}
                required
                style={inputStyle}
              />
            </div>
          </>
        )}

        {mode === "mfa" && (
          <div style={{ marginBottom: "0.75rem" }}>
            <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>{l.mfaTitle}</p>
            <label style={labelStyle}>{l.mfaCode}</label>
            <input
              type="text"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              placeholder="123456"
              required
              style={inputStyle}
              autoFocus
            />
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

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            marginTop: "0.5rem",
            padding: "0.6rem",
            background: "var(--accent, #4f46e5)",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading
            ? l.processing
            : mode === "login"
              ? l.submitLogin
              : mode === "register"
                ? l.submitRegister
                : mode === "device"
                  ? l.deviceSubmit
                  : l.submitMfa}
        </button>

        {mode === "device" && authApi.deviceResend && (
          <button
            type="button"
            onClick={handleResend}
            disabled={loading}
            style={{
              width: "100%",
              marginTop: "0.5rem",
              padding: "0.4rem",
              background: "transparent",
              color: "var(--accent, #4f46e5)",
              border: "none",
              fontSize: "0.85rem",
              cursor: loading ? "wait" : "pointer",
              textDecoration: "underline",
            }}
          >
            {l.deviceResend}
          </button>
        )}

        {(mode === "login" || mode === "register") && !fingerprint && (
          <p style={{ fontSize: "0.7rem", color: "var(--text-muted, #888)", marginTop: "0.5rem", textAlign: "center" }}>
            {l.collectingFingerprint}
          </p>
        )}
      </form>

      {mode !== "mfa" && mode !== "device" && oauth && (oauth.googleUrl || oauth.githubUrl) && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              margin: "1.25rem 0",
              color: "var(--text-muted, #888)",
              fontSize: "0.8rem",
            }}
          >
            <div style={{ flex: 1, height: 1, background: "var(--border, #ccc)" }} />
            <span>{l.orContinueWith}</span>
            <div style={{ flex: 1, height: 1, background: "var(--border, #ccc)" }} />
          </div>

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
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  color: "var(--text-muted, #888)",
  marginBottom: "0.25rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid var(--border, #ccc)",
  borderRadius: "4px",
  background: "var(--bg, #fff)",
  color: "var(--text, #000)",
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

const oauthBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  width: "100%",
  padding: "0.6rem",
  background: "var(--bg-surface-2, #f3f4f6)",
  border: "1px solid var(--border, #ccc)",
  borderRadius: "4px",
  color: "var(--text, #000)",
  fontSize: "0.875rem",
  textDecoration: "none",
  fontWeight: 500,
};
