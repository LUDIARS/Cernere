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
 *   3. ブラウザが fingerprint (machine + browser 情報のみ) を収集 → WS から送信
 *   4. サーバーから state / authenticated / error メッセージを受信
 *   5. authenticated を受け取ったら auth_code を親ウィンドウに返す
 *
 * Query params:
 *   origin       - postMessage 送信先 (popup モード)
 *   redirect_uri - リダイレクト先 (redirect モード)
 */

import { useEffect, useRef, useState } from "react";
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import { collectDeviceFingerprint } from "../../lib/device-fingerprint";
import { fetchAllowedOrigins, isTargetAllowed } from "../../lib/composite-redirect";
import { getAccessToken } from "../../lib/api";

const API_BASE = "";

type Anomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
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
  // スマホは passkey が端末に無い (PC で登録したパスキーは持ち込めない) ことが多い。
  // その場合 passkey 指定でもパスワードフォームを出し、 スマホのパスワードマネージャの
  // 自動入力で入れるようにする。 PC では従来どおり passkey 専用のまま。
  const isMobile = typeof navigator !== "undefined" &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const passkeyOnly = params.get("auth_mode") === "passkey" && !isMobile;

  // 新規登録は Cernere 単体の登録画面へ誘導し、 登録後は呼び出し元 (GLab 等) の
  // origin へ戻す (?redirect=)。 これで「初回登録後に手動で戻る」 が不要になる。
  const returnTarget = origin ?? redirectUri ?? "";
  const registerHref = `/login?mode=register${returnTarget ? `&redirect=${encodeURIComponent(returnTarget)}` : ""}`;

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
  const allowedOriginsRef = useRef<string[]>([]);

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

  // ── 送信先 (origin / redirect_uri) をサーバ許可リストで事前検証 (VULNWEB-001) ──
  // 不正な送信先ならログイン UI を出す前に停止し、 authCode を発行させない。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const allowed = await fetchAllowedOrigins();
      if (cancelled) return;
      allowedOriginsRef.current = allowed;
      const target = origin ?? redirectUri;
      if (!target) {
        setError("送信先が指定されていません (origin / redirect_uri が必要です)。");
      } else if (!isTargetAllowed(target, allowed)) {
        setError("許可されていない送信先です。この画面は安全に続行できません。");
      } else {
        // silent SSO — 既に Cernere ログイン済み (accessToken 保持) なら、 passkey/
        // パスワードの再入力なしで authCode を発行し、 呼び出し元 (GLab 等) へ返す。
        // 失敗 / 未ログインなら通常の対話ログイン UI にフォールバックする。
        const token = getAccessToken();
        if (token) {
          try {
            const res = await fetch(`${API_BASE}/api/auth/composite-session-code`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body: JSON.stringify({ target }),
            });
            if (!cancelled && res.ok) {
              const body = await res.json().catch(() => null) as { authCode?: string } | null;
              if (body?.authCode) { completeAuth(body.authCode); return; }
            }
          } catch {
            /* 対話フローにフォールバック */
          }
        }
      }
    })();
    return () => { cancelled = true; };
    // completeAuth は同一 render の closure で参照 (effect は render 後に走るため定義済み)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, redirectUri]);

  const completeAuth = (authCode: string) => {
    const allowed = allowedOriginsRef.current;
    // 権威はサーバ許可リスト。 postMessage/redirect の直前で必ず再検証し、
    // 許可外の送信先へ authCode を渡さない (fail-closed)。
    if (origin && window.opener) {
      if (!isTargetAllowed(origin, allowed)) {
        setError("許可されていない送信先のため認証を中止しました。");
        return;
      }
      window.opener.postMessage({ type: "cernere:auth", authCode }, new URL(origin).origin);
      window.close();
    } else if (redirectUri) {
      if (!isTargetAllowed(redirectUri, allowed)) {
        setError("許可されていないリダイレクト先のため認証を中止しました。");
        return;
      }
      const url = new URL(redirectUri);
      url.searchParams.set("code", authCode);
      window.location.href = url.toString();
    } else {
      setError("送信先が指定されていません。");
    }
  };

  /** fingerprint を収集して WS に送信。失敗時は setTimeout で再試行。 */
  const collectAndSendFingerprint = (ws: WebSocket) => {
    setFingerprintStatus("collecting");
    try {
      const fp = collectDeviceFingerprint();
      const hasSomething = !!(fp.machine || fp.browser);
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
      retryTimerRef.current = window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          collectAndSendFingerprint(ws);
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
            collectAndSendFingerprint(ws);
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
                collectAndSendFingerprint(ws);
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

  /** Passkey (FaceID / TouchID / Windows Hello / 物理キー) でログイン。
   *  Cernere の通常 /api/auth/passkey/login-begin で options を取り、 ブラウザの
   *  生体認証ダイアログを開く。 verify は /api/auth/passkey/composite-login-finish
   *  で authCode を発行する経路 (= JWT は返さず、 親サービスに postMessage する) */
  const handlePasskeyLogin = async () => {
    setError("");
    setInfo("");
    setLoading(true);
    try {
      const beginRes = await fetch(`${API_BASE}/api/auth/passkey/login-begin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || "" }),
      });
      const beginData = await beginRes.json() as
        { options: PublicKeyCredentialRequestOptionsJSON; challengeOwner: string; error?: string };
      if (!beginRes.ok) throw new Error(beginData.error || "Passkey login start failed");

      const assertion: AuthenticationResponseJSON = await startAuthentication({ optionsJSON: beginData.options });

      const finishRes = await fetch(`${API_BASE}/api/auth/passkey/composite-login-finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: assertion, challengeOwner: beginData.challengeOwner }),
      });
      const finishData = await finishRes.json() as { authCode?: string; error?: string };
      if (!finishRes.ok || !finishData.authCode) {
        throw new Error(finishData.error || "Passkey login failed");
      }

      completeAuth(finishData.authCode);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Passkey login failed";
      setError(msg);
    } finally {
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
            {passkeyOnly
              ? "Passkey でログイン"
              : mode === "device"
                ? "本人確認が必要です"
                : "Sign in to continue"}
          </p>
        </div>

        {/* Tab switcher */}
        {!passkeyOnly && mode !== "device" && (
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
                onClick={() => {
                  // 新規登録は composite (埋め込み) では行わず、 Cernere 単体の
                  // 登録画面へ誘導する (device 検証 / MFA を含む完全なフロー)。
                  if (m === "register") { window.location.href = registerHref; return; }
                  setMode(m); setError(""); setInfo("");
                }}
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

        {!passkeyOnly && <form onSubmit={handleSubmit}>
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
                  name="email"
                  autoComplete="username"
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
                  name="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
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
              デバイス情報を収集中...
            </p>
          )}
        </form>}

        {mode !== "device" && (
          <>
            {!passkeyOnly && <div
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
            </div>}

            {/* Passkey (Face ID / Touch ID / Windows Hello / Android 生体 / 物理キー) */}
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={loading}
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
                fontWeight: 500,
                marginBottom: "0.5rem",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              🔐 Passkey でログイン (Face ID / Touch ID / Windows Hello)
            </button>

            {/* 新規登録導線: 埋め込み (特に passkey 専用) では登録できないため、
                Cernere 単体の登録画面へ誘導する。 */}
            <div style={{ textAlign: "center", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
              <a
                href={registerHref}
                style={{ fontSize: "0.8rem", color: "var(--text-muted)", textDecoration: "underline" }}
              >
                アカウントをお持ちでない方は新規登録
              </a>
            </div>

            {/* Google */}
            {!passkeyOnly && <a
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
            </a>}

            {/* GitHub */}
            {!passkeyOnly && <a
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
            </a>}
          </>
        )}
      </div>
    </div>
  );
}
