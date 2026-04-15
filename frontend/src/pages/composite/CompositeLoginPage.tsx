/**
 * Composite Login Page
 *
 * 他サービスから popup/iframe で開かれるスタンドアロンログインページ。
 * アプリシェル (サイドバー等) なしで、認証成功後に
 * postMessage で auth_code を親ウィンドウに返すか、redirect_uri にリダイレクトする。
 *
 * 本人確認: 普段と異なる環境からのログインを検知した場合、
 * メールで送信された 6 桁コードの入力を対話的に要求する。
 *
 * Query params:
 *   origin       - postMessage 送信先 (popup モード)
 *   redirect_uri - リダイレクト先 (redirect モード)
 */

import { useEffect, useState } from "react";
import {
  collectDeviceFingerprint,
  type DeviceFingerprint,
} from "../../lib/device-fingerprint";

const API_BASE = "";

type Anomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
  | "new_location"
  | "new_ip"
  | "missing_fingerprint";

interface DeviceChallenge {
  deviceToken: string;
  emailMasked?: string;
  anomalies: Anomaly[];
  codeChannel?: "email" | "console";
  deviceLabel?: string;
}

interface CompositeAuthResponseShape {
  authCode?: string;
  mfaRequired?: boolean;
  deviceVerificationRequired?: boolean;
  deviceToken?: string;
  emailMasked?: string;
  anomalies?: Anomaly[];
  codeChannel?: "email" | "console";
  deviceLabel?: string;
  remainingAttempts?: number;
  error?: string;
}

const ANOMALY_LABELS: Record<Anomaly, string> = {
  new_device: "新しいデバイス",
  new_os: "新しい OS",
  new_browser: "新しいブラウザ",
  new_location: "普段と異なる地域",
  new_ip: "普段と異なるネットワーク",
  missing_fingerprint: "デバイス情報を取得できませんでした",
};

export function CompositeLoginPage() {
  const params = new URLSearchParams(window.location.search);
  const origin = params.get("origin");
  const redirectUri = params.get("redirect_uri");

  const [mode, setMode] = useState<"login" | "register" | "device">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [device, setDevice] = useState<DeviceChallenge | null>(null);
  const [deviceCode, setDeviceCode] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // ── マウント時にフィンガープリントを収集 ──
  const [fingerprint, setFingerprint] = useState<DeviceFingerprint | null>(null);
  useEffect(() => {
    let cancelled = false;
    collectDeviceFingerprint({ requestGeo: true, geoTimeoutMs: 5000 })
      .then((fp) => { if (!cancelled) setFingerprint(fp); })
      .catch(() => { if (!cancelled) setFingerprint(null); });
    return () => { cancelled = true; };
  }, []);

  const completeAuth = (authCode: string) => {
    if (origin && window.opener) {
      // Popup モード: postMessage で auth_code を送信
      window.opener.postMessage({ type: "cernere:auth", authCode }, origin);
      window.close();
    } else if (redirectUri) {
      // Redirect モード: redirect_uri に auth_code を付与してリダイレクト
      const url = new URL(redirectUri);
      url.searchParams.set("code", authCode);
      window.location.href = url.toString();
    }
  };

  const callApi = async (action: string, body: Record<string, unknown>): Promise<CompositeAuthResponseShape> => {
    const res = await fetch(`${API_BASE}/api/auth/composite/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as CompositeAuthResponseShape & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Authentication failed");
    return data;
  };

  const handleResponse = (data: CompositeAuthResponseShape) => {
    if (data.mfaRequired) {
      setError("MFA is required but not yet supported in composite mode.");
      return;
    }
    if (data.deviceVerificationRequired && data.deviceToken) {
      setDevice({
        deviceToken: data.deviceToken,
        emailMasked: data.emailMasked,
        anomalies: data.anomalies ?? [],
        codeChannel: data.codeChannel,
        deviceLabel: data.deviceLabel,
      });
      setDeviceCode("");
      setMode("device");
      return;
    }
    if (data.authCode) {
      completeAuth(data.authCode);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    try {
      if (mode === "device") {
        if (!device) throw new Error("No active device challenge");
        const data = await callApi("device-verify", {
          deviceToken: device.deviceToken,
          code: deviceCode.trim(),
        });
        if (data.error) {
          const remaining = typeof data.remainingAttempts === "number"
            ? `（残り ${data.remainingAttempts} 回）`
            : "";
          throw new Error(`${data.error}${remaining}`);
        }
        handleResponse(data);
      } else {
        const action = mode === "register" ? "register" : "login";
        const body = mode === "register"
          ? { name, email, password, device: fingerprint ?? undefined }
          : { email, password, device: fingerprint ?? undefined };
        const data = await callApi(action, body);
        handleResponse(data);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!device) return;
    setError("");
    setInfo("");
    setLoading(true);
    try {
      await callApi("device-resend", { deviceToken: device.deviceToken });
      setInfo("確認コードを再送しました。");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Resend failed");
    } finally {
      setLoading(false);
    }
  };

  // OAuth URL にcomposite_origin を付与
  const compositeParam = origin
    ? `composite_origin=${encodeURIComponent(origin)}`
    : redirectUri
      ? `composite_origin=${encodeURIComponent(redirectUri)}`
      : "";

  const googleAuthUrl = `/auth/google/login${compositeParam ? `?${compositeParam}` : ""}`;
  const githubAuthUrl = `/auth/github/login${compositeParam ? `?${compositeParam}` : ""}`;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: 400,
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "2rem",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            Cernere
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            {mode === "device" ? "本人確認が必要です" : "Sign in to continue"}
          </p>
        </div>

        {/* Tab switcher */}
        {mode !== "device" && (
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--border)",
              marginBottom: "1.5rem",
            }}
          >
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(""); setInfo(""); }}
                style={{
                  flex: 1,
                  padding: "0.5rem",
                  background: "transparent",
                  border: "none",
                  borderBottom: mode === m ? "2px solid var(--accent)" : "2px solid transparent",
                  color: mode === m ? "var(--text)" : "var(--text-muted)",
                  fontWeight: mode === m ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {m === "login" ? "Login" : "Register"}
              </button>
            ))}
          </div>
        )}

        {info && (
          <div
            style={{
              background: "rgba(34, 197, 94, 0.1)",
              border: "1px solid var(--green, #22c55e)",
              borderRadius: "var(--radius-sm)",
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
              border: "1px solid var(--red)",
              borderRadius: "var(--radius-sm)",
              padding: "0.5rem 0.75rem",
              marginBottom: "1rem",
              fontSize: "0.85rem",
              color: "var(--red)",
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {mode === "register" && (
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
              />
            </div>
          )}

          {(mode === "login" || mode === "register") && (
            <>
              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  required
                />
              </div>

              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8+ characters"
                  minLength={8}
                  required
                />
              </div>
            </>
          )}

          {mode === "device" && device && (
            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ fontSize: "0.9rem", marginBottom: "0.25rem" }}>
                普段と異なる環境からのアクセスを検知しました。
              </p>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
                {device.emailMasked
                  ? `${device.emailMasked} に確認コードを送信しました。`
                  : "確認コードを送信しました。"}
              </p>

              {device.deviceLabel && (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  <strong>デバイス:</strong> {device.deviceLabel}
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
                      {ANOMALY_LABELS[a] ?? a}
                    </span>
                  ))}
                </div>
              )}

              <div className="form-group">
                <label>確認コード (6 桁)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={deviceCode}
                  onChange={(e) => setDeviceCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  required
                  autoFocus
                  style={{
                    fontFamily: "monospace",
                    letterSpacing: "0.25em",
                    textAlign: "center",
                    fontSize: "1.1rem",
                  }}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            className="primary"
            disabled={loading}
            style={{ width: "100%", marginTop: "0.5rem", padding: "0.6rem" }}
          >
            {loading
              ? "Processing..."
              : mode === "device"
                ? "確認コードを検証"
                : mode === "login"
                  ? "Login"
                  : "Create Account"}
          </button>

          {mode === "device" && (
            <button
              type="button"
              onClick={handleResend}
              disabled={loading}
              style={{
                width: "100%",
                marginTop: "0.5rem",
                padding: "0.4rem",
                background: "transparent",
                color: "var(--accent)",
                border: "none",
                fontSize: "0.85rem",
                cursor: loading ? "wait" : "pointer",
                textDecoration: "underline",
              }}
            >
              確認コードを再送
            </button>
          )}

          {mode !== "device" && !fingerprint && (
            <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.5rem", textAlign: "center" }}>
              デバイス情報を収集中...
            </p>
          )}
        </form>

        {mode !== "device" && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                margin: "1.25rem 0",
                color: "var(--text-muted)",
                fontSize: "0.8rem",
              }}
            >
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span>or</span>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>

            {/* Google */}
            <a
              href={googleAuthUrl}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                width: "100%",
                padding: "0.6rem",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                fontSize: "0.875rem",
                textDecoration: "none",
                fontWeight: 500,
                marginBottom: "0.5rem",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
                <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
              </svg>
              Continue with Google
            </a>

            {/* GitHub */}
            <a
              href={githubAuthUrl}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                width: "100%",
                padding: "0.6rem",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                fontSize: "0.875rem",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Continue with GitHub
            </a>
          </>
        )}
      </div>
    </div>
  );
}
