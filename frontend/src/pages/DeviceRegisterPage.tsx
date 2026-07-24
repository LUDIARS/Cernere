/**
 * 他デバイス登録ページ (新しい端末側)。
 *
 * ログイン済み端末で発行した one-time URL (`/device-register?token=...`) を
 * この端末で開き、 Windows Hello / スマホ生体認証でこの端末自身の passkey を
 * 同じアカウントへ追加する。 成功するとこの端末はそのままログイン状態になる。
 *
 * email 無しアカウントが新しい端末を使えるようにする唯一の経路。
 * token は 15 分 TTL・単回 (begin 時点で消費)。 失敗したら元の端末で再発行する。
 */

import { useMemo, useState } from "react";
import { auth as authApi } from "../lib/api";

export function DeviceRegisterPage() {
  const token = useMemo(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
    [],
  );
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState("");

  const handleRegister = async () => {
    setError("");
    setStatus("working");
    try {
      await authApi.passkeyDeviceRegister(token, nickname.trim() || undefined);
      setStatus("done");
      window.location.href = "/";
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "デバイス登録に失敗しました");
      setStatus("idle");
    }
  };

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
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>Cernere</h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            このデバイスをアカウントに登録
          </p>
        </div>

        {!token ? (
          <p style={{ fontSize: "0.85rem", color: "var(--red)" }}>
            登録リンクが不正です。ログイン済みの端末で「他のデバイスを登録」から
            リンクを発行し直してください。
          </p>
        ) : (
          <>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.7, marginBottom: "1rem" }}>
              この端末の生体認証 / PIN (Windows Hello・Face ID・Android 生体認証) を
              パスキーとして追加します。登録が完了すると、この端末でそのまま
              ログイン状態になります。
            </p>

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
                <div style={{ marginTop: "0.25rem", color: "var(--text-muted)" }}>
                  リンクは 15 分・1 回限り有効です。失敗した場合は元の端末で再発行してください。
                </div>
              </div>
            )}

            <div className="form-group">
              <label>この端末のニックネーム（任意）</label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="例: 自宅 PC / iPhone 15"
                maxLength={64}
              />
            </div>

            <button
              type="button"
              className="primary"
              disabled={status !== "idle"}
              onClick={() => { void handleRegister(); }}
              style={{ width: "100%", marginTop: "0.5rem", padding: "0.6rem" }}
            >
              {status === "working"
                ? "登録中…"
                : status === "done"
                  ? "登録完了"
                  : "🔐 この端末を登録（生体認証 / PIN）"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
