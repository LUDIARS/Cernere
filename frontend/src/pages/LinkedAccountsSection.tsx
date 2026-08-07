// 連携アカウント (GitHub / Google / Discord) の一覧と link/unlink。
//
// Discord は連携先サービスでの個人メンションと本人確認にだけ使う識別子で、認可トークンは
// サーバ側に保存しない。 最後のログイン手段は解除させない (アカウントに入れなくなる)。

import { useState, useEffect, useCallback } from "react";
import { auth as authApi } from "../lib/api";

export function LinkedAccountsSection() {
  const [account, setAccount] = useState<Awaited<ReturnType<typeof authApi.me>> | null>(null);
  const [message, setMessage] = useState("");
  const [linking, setLinking] = useState<"github" | "google" | "discord" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccount(await authApi.me());
    } catch (error) {
      setMessage(`⚠ ${(error as Error).message}`);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const unlink = async (provider: "github" | "google" | "discord") => {
    if (!window.confirm(`${provider} との連携を解除しますか?`)) return;
    try {
      await authApi.unlinkProvider(provider, account?.hasPasskey ?? false);
      setMessage("✓ 連携を解除しました");
      await refresh();
    } catch (error) {
      setMessage(`⚠ ${(error as Error).message}`);
    }
  };

  const link = async (provider: "github" | "google" | "discord") => {
    setLinking(provider);
    setMessage("");
    try {
      const authorizationUrl = await authApi.startLinkProvider(provider, account?.hasPasskey ?? false);
      window.location.assign(authorizationUrl);
    } catch (error) {
      setLinking(null);
      setMessage(`⚠ ${(error as Error).message}`);
    }
  };

  if (!account) return null;
  // server 側 unlink と同じ集合 (password / passkey / OAuth) で数える。 passkey を
  // 落とすと passkey のみのユーザで解除ボタンが誤って無効化される。
  const loginMethodCount = Number(account.hasPassword) + Number(account.hasPasskey)
    + Number(account.hasGoogleAuth) + Number(account.hasGitHubAuth);
  const rows = [
    { key: "github" as const, label: "GitHub", linked: !!account.hasGitHubAuth, detail: "GitHub アカウント" },
    { key: "google" as const, label: "Google", linked: !!account.hasGoogleAuth, detail: "Google アカウント" },
    { key: "discord" as const, label: "Discord", linked: !!account.hasDiscordAuth, detail: account.discordUsername ?? "Discord アカウント" },
  ];

  return (
    <div style={{ background: "var(--bg-surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", marginTop: "1rem" }}>
      <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>🔗 連携アカウント</h2>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>Discord は連携先サービスでの個人メンションと本人確認にだけ使用し、認可トークンは保存しません。</p>
      {message && <div style={{ fontSize: "0.8rem", marginBottom: "0.5rem", color: message.startsWith("⚠") ? "var(--red)" : "var(--green)" }}>{message}</div>}
      {rows.map((row) => {
        const isLastLoginMethod = row.key !== "discord" && row.linked && loginMethodCount <= 1;
        return (
          <div key={row.key} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ flex: 1 }}><strong>{row.label}</strong><div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{row.linked ? `連携済み: ${row.detail}` : "未連携"}</div></div>
            {row.linked
              ? <button type="button" disabled={isLastLoginMethod} title={isLastLoginMethod ? "最後のログイン手段は解除できません" : undefined} onClick={() => { void unlink(row.key); }}>解除</button>
              : <button type="button" disabled={linking !== null} onClick={() => { void link(row.key); }}>{linking === row.key ? "移動中…" : "連携する"}</button>}
          </div>
        );
      })}
      {loginMethodCount <= 1 && <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>最後のログイン手段は、アカウントに入れなくなるため解除できません。</p>}
    </div>
  );
}
