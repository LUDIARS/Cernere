import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "../lib/api";

/**
 * 会場チェックイン (session ベース、 passkey 再入力なし)。
 *
 * 前提: このページは Cernere frontend (ユーザの accessToken を localStorage に持つ origin)
 * で開かれる。 会場の Ostiarius ゲートウェイ URL は QR / クエリ `?gateway=` で渡す。
 *
 *   1. localStorage の accessToken を取得 (Cernere ログイン済みが前提)
 *   2. `${gateway}/checkin/session` に Bearer で POST → Ostiarius が token 検証 → attestation 発行
 *   3. (任意) `?aedilis=` があれば attestation を Aedilis `/api/checkin/verify` に提出
 *
 * ログイン済みなら開いた瞬間に自動実行する ("ログインできたら自動で")。
 *
 * 注意: `https://` ページから `http://<LAN-IP>` への fetch は mixed content でブロックされる。
 * `http://localhost` は例外的に許可されるため PC 検証はそのまま可。 スマホ+LAN-IP 運用では
 * Ostiarius を HTTPS 化するか、 Ostiarius 自身がこのページを配信する (same-origin) 必要がある。
 */

type Phase = "idle" | "need-login" | "running" | "checked-in" | "error";

interface CheckinResult {
  attestation: string;
  profile: { name?: string; departmentName?: string; grade?: number } | null;
}

function profileLabel(p: CheckinResult["profile"]): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.departmentName) parts.push(p.departmentName);
  if (p.grade) parts.push(`${p.grade}年`);
  if (p.name) parts.push(`${p.name} さん`);
  return parts.join(" / ");
}

export function CheckinPage() {
  const params = new URLSearchParams(window.location.search);
  const aedilis = (params.get("aedilis") ?? "").replace(/\/+$/, "");

  const [gateway, setGateway] = useState((params.get("gateway") ?? "").replace(/\/+$/, ""));
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<CheckinResult | null>(null);
  const ranRef = useRef(false);

  const checkin = async (gw: string) => {
    const token = getAccessToken();
    if (!token) {
      setPhase("need-login");
      setMessage("Cernere にログインしてからチェックインしてください。");
      return;
    }
    if (!gw) {
      setPhase("error");
      setMessage("会場ゲートウェイ (gateway) が指定されていません。QR を読み取るか URL を入力してください。");
      return;
    }
    setPhase("running");
    setMessage("チェックイン中…");
    try {
      // token は body で渡す。 Ostiarius の CORS allowHeaders は content-type のみのため、
      // Authorization ヘッダにするとブラウザの preflight で弾かれる。
      const res = await fetch(`${gw}/checkin/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.attestation) {
        setPhase("error");
        setMessage(body?.error ?? `チェックインに失敗しました (HTTP ${res.status})。`);
        return;
      }
      const checkinResult: CheckinResult = { attestation: body.attestation, profile: body.profile ?? null };

      // 任意: Aedilis に attestation を提出して出席記録
      if (aedilis) {
        setMessage("出席を記録中…");
        const vr = await fetch(`${aedilis}/api/checkin/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ attestation: checkinResult.attestation }),
        }).catch(() => null);
        if (!vr || !vr.ok) {
          setResult(checkinResult);
          setPhase("error");
          setMessage("会場での本人確認は成功しましたが、出席記録 (Aedilis) に失敗しました。");
          return;
        }
      }

      setResult(checkinResult);
      setPhase("checked-in");
      setMessage(aedilis ? "チェックイン完了 — 出席を記録しました。" : "会場チェックイン成功 (attestation 発行済み)。");
    } catch (err) {
      setPhase("error");
      const m = err instanceof Error ? err.message : String(err);
      // localhost 以外の http への https からの fetch は mixed content で失敗する
      setMessage(`ゲートウェイに接続できませんでした: ${m}`);
    }
  };

  // ログイン済み & gateway 指定ありなら自動実行 (1 回だけ)
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (getAccessToken() && gateway) void checkin(gateway);
    else if (!getAccessToken()) {
      setPhase("need-login");
      setMessage("Cernere にログインしてからチェックインしてください。");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <div style={{ width: 400, maxWidth: "92vw", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "2rem" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "0.25rem" }}>会場チェックイン</h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "1.25rem" }}>
          Cernere ログイン済みなら、この会場ネットワークからパスキーなしでチェックインします。
        </p>

        {phase === "need-login" && (
          <a href={`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`}
             style={{ display: "block", textAlign: "center", padding: "0.6rem", borderRadius: "var(--radius-sm)", background: "var(--accent, #2563eb)", color: "#fff", textDecoration: "none", fontWeight: 600 }}>
            ログインする
          </a>
        )}

        {phase !== "need-login" && (
          <>
            <div className="form-group" style={{ marginBottom: "0.75rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>
                会場ゲートウェイ URL
              </label>
              <input
                type="url"
                value={gateway}
                onChange={(e) => setGateway(e.target.value.replace(/\/+$/, ""))}
                placeholder="http://192.168.x.x:17590"
                style={{ width: "100%", padding: "0.5rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}
              />
            </div>
            <button
              type="button"
              disabled={phase === "running" || !gateway}
              onClick={() => void checkin(gateway)}
              style={{ width: "100%", padding: "0.6rem", border: "none", borderRadius: "var(--radius-sm)", background: "var(--accent, #2563eb)", color: "#fff", fontWeight: 600, cursor: phase === "running" ? "not-allowed" : "pointer", opacity: phase === "running" ? 0.6 : 1 }}
            >
              {phase === "running" ? "処理中…" : "チェックインする"}
            </button>
          </>
        )}

        {message && (
          <div style={{ marginTop: "1rem", fontSize: "0.9rem", color: phase === "checked-in" ? "var(--green, #16a34a)" : phase === "error" ? "var(--red, #b91c1c)" : "var(--text)" }}>
            {message}
          </div>
        )}

        {result && phase === "checked-in" && (
          <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
            {profileLabel(result.profile) && <p style={{ fontWeight: 600 }}>{profileLabel(result.profile)}</p>}
            <details>
              <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>attestation</summary>
              <code style={{ wordBreak: "break-all", fontSize: "0.7rem" }}>{result.attestation}</code>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
