/**
 * Composite Login Page
 *
 * 他サービスから popup/iframe で開かれるスタンドアロンログインページ。
 * アプリシェル (サイドバー等) なしで、認証成功後に
 * postMessage で auth_code を親ウィンドウに返すか、redirect_uri にリダイレクトする。
 *
 * フロー:
 *   1. POST /api/auth/composite/login (or register) で資格情報検証
 *      → { ticket, wsPath } を取得
 *   2. WS `/auth/composite-ws?ticket=...` に接続
 *   3. ブラウザが fingerprint (Geolocation 含む) を収集 → WS から送信
 *      → パーミッションが取れるまで何度でも再試行可能
 *   4. サーバーから state / authenticated / error メッセージを受信
 *   5. authenticated を受け取ったら auth_code を親ウィンドウに返す
 *
 * Query params:
 *   origin       - postMessage 送信先 (popup モード)
 *   redirect_uri - リダイレクト先 (redirect モード)
 */

import { useEffect, useRef, useState } from "react";
import { collectDeviceFingerprint } from "../../lib/device-fingerprint";

const API_BASE = "";

type Anomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
  | "new_location"
  | "new_ip"
  | "missing_fingerprint";

type WsState =
  | "pending_device"
  | "challenge_pending"
  | "authenticated"
  | "expired";

interface ChallengeInfo {
  deviceToken?: string;
  emailMasked?: string;
  anomalies?: Anomaly[];
  codeChannel?: "email" | "console";
  deviceLabel?: string;
  error?: string;
  remainingAttempts?: number;
  resent?: boolean;
}

interface LoginResponseShape {
  ticket?: string;
  wsPath?: string;
  mfaRequired?: boolean;
  error?: string;
}

type ServerMessage =
  | { type: "state"; state: WsState; data?: ChallengeInfo }
  | { type: "authenticated"; authCode: string }
  | { type: "error"; retryable: boolean; reason: string }
  | { type: "ping"; ts: number };

const ANOMALY_LABELS: Record<Anomaly, string> = {
  new_device: "新しいデバイス",
  new_os: "新しい OS",
  new_browser: "新しいブラウザ",
  new_location: "普段と異なる地域",
  new_ip: "普段と異なるネットワーク",
  missing_fingerprint: "デバイス情報を取得できませんでした",
};

/** WS の URL を構築する (HTTPS → wss, HTTP → ws) */
function buildWsUrl(wsPath: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  // 開発時 Vite proxy の下で動くため location.host を使用
  return `${proto}://${window.location.host}${wsPath}`;
}

export function CompositeLoginPage() {
  const params = new URLSearchParams(window.location.search);
  const origin = params.get("origin");
  const redirectUri = params.get("redirect_uri");

  const [mode, setMode] = useState<"login" | "register" | "device">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<ChallengeInfo | null>(null);
  const [deviceCode, setDeviceCode] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fingerprintStatus, setFingerprintStatus] =
    useState<"idle" | "collecting" | "sent" | "failed">("idle");

  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  // ── アンマウント時の掃除 ──
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const completeAuth = (authCode: string) => {
    if (origin && window.opener) {
      window.opener.postMessage({ type: "cernere:auth", authCode }, origin);
      window.close();
    } else if (redirectUri) {
      const url = new URL(redirectUri);
      url.searchParams.set("code", authCode);
      window.location.href = url.toString();
    }
  };

  /** fingerprint を収集して WS に送信。失敗時は setTimeout で再試行。 */
  const collectAndSendFingerprint = async (ws: WebSocket) => {
    setFingerprintStatus("collecting");
    try {
      // パーミッションを強制的に要求しながら収集
      const fp = await collectDeviceFingerprint({ requestGeo: true, geoTimeoutMs: 15000 });
      const hasSomething = !!(fp.machine || fp.browser || fp.geo);
      if (!hasSomething) {
        throw new Error("empty fingerprint");
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "device", payload: fp }));
      setFingerprintStatus("sent");
    } catch (err: unknown) {
      setFingerprintStatus("failed");
      const msg = err instanceof Error ? err.message : "fingerprint collection failed";
      setError(`デバイス情報の取得に失敗しました: ${msg}。再試行します…`);
      // 3秒後に再試行 (パーミッションダイアログ / ネットワーク復旧を待つ)
      retryTimerRef.current = window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          void collectAndSendFingerprint(ws);
        }
      }, 3000);
    }
  };

  /** サーバーメッセージを処理 */
  const handleServerMessage = (ws: WebSocket, msg: ServerMessage) => {
    switch (msg.type) {
      case "state":
        if (msg.state === "pending_device") {
          // fingerprint 未送信なら収集して送信
          if (fingerprintStatus !== "sent") {
            void collectAndSendFingerprint(ws);
          }
        } else if (msg.state === "challenge_pending") {
          setChallenge(msg.data ?? {});
          if (msg.data?.resent) {
            setInfo("確認コードを再送しました。");
            setError("");
          } else if (msg.data?.error) {
            setError(
              msg.data.remainingAttempts !== undefined
                ? `${msg.data.error}（残り ${msg.data.remainingAttempts} 回）`
                : msg.data.error,
            );
          } else {
            setError("");
            setInfo("");
          }
          setMode("device");
          setLoading(false);
        } else if (msg.state === "authenticated") {
          // 次の "authenticated" メッセージで authCode が届く
        } else if (msg.state === "expired") {
          setError("認証セッションが期限切れです。最初からやり直してください。");
          setLoading(false);
          try { ws.close(); } catch { /* ignore */ }
          wsRef.current = null;
        }
        return;
      case "authenticated":
        completeAuth(msg.authCode);
        return;
      case "error":
        if (msg.retryable) {
          // retryable はクライアント側で自動回復できることが多い
          setError(`通信エラー (再試行中): ${msg.reason}`);
          if (msg.reason.includes("fingerprint") && fingerprintStatus !== "sent") {
            // fingerprint 空エラーなら直ちに再収集
            retryTimerRef.current = window.setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                void collectAndSendFingerprint(ws);
              }
            }, 500);
          }
        } else {
          setError(msg.reason);
          setLoading(false);
          try { ws.close(); } catch { /* ignore */ }
          wsRef.current = null;
        }
        return;
      case "ping":
        try {
          ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        } catch { /* ignore */ }
        return;
    }
  };

  /** WS を開いて fingerprint フローを開始 */
  const startWsFlow = (wsPath: string) => {
    const url = buildWsUrl(wsPath);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setFingerprintStatus("idle");

    ws.onopen = () => {
      // fingerprint 送信は open 時ではなく "state: pending_device" を待ってから。
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        handleServerMessage(ws, msg);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onerror = () => {
      setError("WebSocket 接続エラーが発生しました。");
      setLoading(false);
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
  };

  const callApi = async (action: string, body: Record<string, unknown>): Promise<LoginResponseShape> => {
    const res = await fetch(`${API_BASE}/api/auth/composite/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as LoginResponseShape;
    if (!res.ok) throw new Error(data.error ?? "Authentication failed");
    return data;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);

    try {
      if (mode === "device") {
        // 本人確認コードの送信は WS で
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error("接続が切断されました。最初からやり直してください。");
        }
        ws.send(JSON.stringify({ type: "verify_code", code: deviceCode.trim() }));
        // 結果は onmessage → state で処理
      } else {
        const action = mode === "register" ? "register" : "login";
        const body = mode === "register"
          ? { name, email, password }
          : { email, password };
        const data = await callApi(action, body);
        if (data.mfaRequired) {
          setError("MFA is required but not yet supported in composite mode.");
          setLoading(false);
          return;
        }
        if (!data.wsPath) {
          throw new Error("Missing wsPath in login response");
        }
        startWsFlow(data.wsPath);
        // fingerprint 送信と以降は WS で。loading は state 受信時に解除。
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
      setLoading(false);
    }
  };

  const handleResend = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("接続が切断されました。最初からやり直してください。");
      return;
    }
    setError("");
    setInfo("");
    ws.send(JSON.stringify({ type: "resend" }));
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

          {mode === "device" && challenge && (
            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ fontSize: "0.9rem", marginBottom: "0.25rem" }}>
                普段と異なる環境からのアクセスを検知しました。
              </p>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
                {challenge.emailMasked
                  ? `${challenge.emailMasked} に確認コードを送信しました。`
                  : "確認コードを送信しました。"}
              </p>

              {challenge.deviceLabel && (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  <strong>デバイス:</strong> {challenge.deviceLabel}
                </p>
              )}

              {challenge.anomalies && challenge.anomalies.length > 0 && (
                <div style={{ marginBottom: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                  {challenge.anomalies.map((a) => (
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

          {mode !== "device" && fingerprintStatus === "collecting" && (
            <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.5rem", textAlign: "center" }}>
              デバイス情報を収集中... (位置情報の許可が必要です)
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
