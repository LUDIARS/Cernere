import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { LoginPage } from "../LoginPage";
import { oidc, type OidcConsentInfo } from "../../lib/api";

/** scope → ユーザー向けの説明ラベル。 */
const SCOPE_LABELS: Record<string, string> = {
  openid: "基本的な ID (あなたを識別するための固有 ID)",
  email: "メールアドレス",
  profile: "プロフィール (表示名・ユーザー名・アイコン)",
};

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <span style={{ color: "var(--text-muted)" }}>Loading...</span>
    </div>
  );
}

/**
 * OIDC 認可同意ページ。
 *
 * `/oidc/authorize` が検証後にここへ redirect する (?request_id=...)。
 * 未ログインなら LoginPage を inline 表示し、 ログイン完了後 (AuthContext の
 * user 更新) に同意 UI へ自動で切り替わる。 承認/拒否すると RP の redirect_uri
 * へ window.location で戻る。
 */
export function OidcConsentPage() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const requestId = params.get("request_id") ?? "";

  const [info, setInfo] = useState<OidcConsentInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) {
      setError("認可リクエストが指定されていません (request_id 無し)");
      setLoadingInfo(false);
      return;
    }
    oidc.getRequest(requestId)
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "リクエストの読み込みに失敗しました"))
      .finally(() => setLoadingInfo(false));
  }, [requestId]);

  if (loading) return <Spinner />;
  // 未ログイン: ログインフォームを表示。 ログイン成功で user が入り再描画される。
  if (!user) return <LoginPage />;
  if (loadingInfo) return <Spinner />;

  const act = async (kind: "approve" | "deny") => {
    setBusy(true);
    setError("");
    try {
      const { redirectTo } = kind === "approve" ? await oidc.approve(requestId) : await oidc.deny(requestId);
      window.location.href = redirectTo;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setBusy(false);
    }
  };

  let redirectHost = info?.redirectUri ?? "";
  try { redirectHost = new URL(info!.redirectUri).host; } catch { /* keep raw */ }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <div style={{ width: 440, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "2rem" }}>
        <div style={{ textAlign: "center", marginBottom: "1.25rem" }}>
          <h1 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: "0.25rem" }}>アクセスの許可</h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            <strong style={{ color: "var(--text)" }}>{info?.clientName ?? "アプリ"}</strong> が
            あなたの Cernere アカウントへのアクセスを求めています
          </p>
        </div>

        {error && (
          <div style={{ background: "rgba(248, 81, 73, 0.1)", border: "1px solid var(--red)", borderRadius: "var(--radius-sm)", padding: "0.5rem 0.75rem", marginBottom: "1rem", fontSize: "0.85rem", color: "var(--red)" }}>
            {error}
          </div>
        )}

        {info && (
          <>
            <div style={{ background: "var(--bg-surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              ログイン中: <strong style={{ color: "var(--text)" }}>{user.name}</strong>（{user.email}）
            </div>

            <p style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>共有される情報</p>
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1.25rem" }}>
              {info.scopes.map((s) => (
                <li key={s} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", padding: "0.4rem 0", fontSize: "0.85rem" }}>
                  <span style={{ color: "var(--accent)" }}>✓</span>
                  <span>{SCOPE_LABELS[s] ?? s}</span>
                </li>
              ))}
            </ul>

            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
              承認すると <strong style={{ color: "var(--text)" }}>{redirectHost}</strong> にリダイレクトされます。
            </p>

            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button
                type="button"
                onClick={() => act("deny")}
                disabled={busy}
                style={{ flex: 1, padding: "0.6rem", background: "var(--bg-surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}
              >
                拒否
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => act("approve")}
                disabled={busy}
                style={{ flex: 1, padding: "0.6rem" }}
              >
                {busy ? "処理中..." : "許可する"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
