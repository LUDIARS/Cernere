/**
 * サービス初回ログイン時の権限確認 (/consent?ticket=...)。
 *
 * サービスへのログイン (popup / ダッシュボードの「開く」/ サービス経由 / edge) で同意が要るとき、
 * Cernere がここへ案内する。ticket の継続先はサーバが発行時に検証済みで、この画面はクエリから
 * 戻り先を受け取らない (open redirect 防止)。
 *
 * - 必須を拒否するとログインを中止し、サービスへ consent_denied を返す
 * - 推奨は既定オフ。外したまま進められる
 * - サービス経由の ticket は本人の Cernere ログインを求める (未ログインならログイン画面を出す)
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { LoginPage } from "../LoginPage";
import { PermissionList, initialRecommendedSelection } from "../../components/consent/PermissionList";
import {
  ConsentApiError,
  consentTicketApi,
  deliverConsentOutcome,
  type ConsentTicketInfo,
} from "../../lib/consent-api";

const shellStyle: CSSProperties = {
  minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)",
};
const cardStyle: CSSProperties = {
  width: 520, maxWidth: "calc(100vw - 2rem)", background: "var(--bg-surface)", border: "1px solid var(--border)",
  borderRadius: "var(--radius)", padding: "2rem",
};

type Phase = "loading" | "needs_login" | "ready" | "done" | "error";

export function ConsentPage() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const ticket = params.get("ticket") ?? "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<ConsentTicketInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!ticket) {
      setMessage("確認するリクエストが指定されていません。サービスからもう一度ログインしてください。");
      setPhase("error");
      return;
    }
    let cancelled = false;
    setPhase("loading");
    consentTicketApi.get(ticket)
      .then((result) => {
        if (cancelled) return;
        setInfo(result);
        setSelected(initialRecommendedSelection(result.view));
        setPhase("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ConsentApiError && e.code === "consent_session_required" && !user) {
          setPhase("needs_login");
          return;
        }
        setMessage(e instanceof Error ? e.message : "読み込みに失敗しました");
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, [ticket, user, loading]);

  const decide = async (decision: "grant" | "deny") => {
    setBusy(true);
    setMessage("");
    try {
      const outcome = await consentTicketApi.decide(ticket, decision, [...selected]);
      if (deliverConsentOutcome(outcome)) return;
      setMessage(decision === "grant"
        ? "許可しました。サービスの画面に戻り、もう一度ログインしてください。"
        : "許可しなかったため、このサービスにはログインしませんでした。");
      setPhase("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (loading || phase === "loading") {
    return <div style={shellStyle}><span style={{ color: "var(--text-muted)" }}>Loading...</span></div>;
  }
  // サービス経由の確認は本人の Cernere ログインが要る。ログインすると user が入り再読み込みされる。
  if (phase === "needs_login") return <LoginPage />;

  return (
    <div style={shellStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: "0.25rem", textAlign: "center" }}>サービスの権限の確認</h1>
        {info && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", marginBottom: "1.25rem" }}>
            <strong style={{ color: "var(--text)" }}>{info.serviceName}</strong> を使うために、次の権限を確認してください。
            {info.view.reconsent && <><br />前回の確認から権限が増えています。</>}
          </p>
        )}

        {message && (
          <div role="status" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.6rem 0.75rem", marginBottom: "1rem", fontSize: "0.85rem" }}>
            {message}
          </div>
        )}

        {info && phase === "ready" && (
          <>
            <PermissionList
              view={info.view}
              selected={selected}
              disabled={busy}
              onToggle={(key, checked) => setSelected((prev) => {
                const next = new Set(prev);
                if (checked) next.add(key); else next.delete(key);
                return next;
              })}
            />
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
              あとから Cernere の「サービスの権限」で推奨の取り消しや、このサービスの利用停止ができます。
            </p>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button type="button" disabled={busy} onClick={() => void decide("deny")}
                style={{ flex: 1, padding: "0.6rem", background: "var(--bg-surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)" }}>
                許可しない
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void decide("grant")} style={{ flex: 1, padding: "0.6rem" }}>
                {busy ? "処理中..." : "許可して続ける"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
