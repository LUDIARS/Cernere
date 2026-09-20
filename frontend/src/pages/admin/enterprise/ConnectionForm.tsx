/** Administrator-owned trust and session policy editor. @implements SPEC-ENTERPRISE-ADMIN */
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ConnectionSettings, EnterpriseConnection, EnterpriseConfiguration, EnterpriseMutation } from "./types";

export function ConnectionForm({ connection, configuration, busy, save }: {
  connection?: EnterpriseConnection; configuration: EnterpriseConfiguration; busy: boolean; save: EnterpriseMutation;
}) {
  const [draft, setDraft] = useState<ConnectionSettings>(() => {
    if (connection) { const { revision: _revision, ...settings } = connection; return settings; }
    return { projectKey: "", organizationId: "", oidcClientId: "", teamDomain: "", audience: "",
      requireMfa: true, maxAuthenticationAge: 3600, maxSessionSeconds: 3600, isActive: false };
  });
  const field = <K extends keyof ConnectionSettings>(key: K, value: ConnectionSettings[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const callback = draft.teamDomain ? `https://${draft.teamDomain}/cdn-cgi/access/callback` : "";
  const eligibleClients = configuration.clients.filter((client) => client.redirectUris.length === 1 && client.redirectUris[0] === callback);
  return <form onSubmit={(event) => {
    event.preventDefault();
    void save("save_connection", { projectKey: draft.projectKey, organizationId: draft.organizationId,
      oidcClientId: draft.oidcClientId, teamDomain: draft.teamDomain, audience: draft.audience,
      requireMfa: draft.requireMfa, maxAuthenticationAge: draft.maxAuthenticationAge, maxSessionSeconds: draft.maxSessionSeconds,
      isActive: draft.isActive, expectedRevision: connection?.revision ?? null });
  }}>
    <fieldset disabled={busy} style={{ display: "grid", gap: "0.8rem", border: "1px solid var(--border)", padding: "1rem" }}>
      <legend>{connection ? "接続・認証ポリシーの編集" : "企業接続の登録"}</legend>
      <label>プロジェクト <select required disabled={!!connection} value={draft.projectKey} onChange={(e) => field("projectKey", e.target.value)}>
        <option value="">選択してください</option>
        {configuration.projects.filter((project) => project.key === connection?.projectKey || !configuration.connections.some((c) => c.projectKey === project.key))
          .map((project) => <option key={project.key} value={project.key}>{project.name} ({project.key}){!project.isActive && "・無効"}</option>)}
      </select></label>
      <label>組織 <select required value={draft.organizationId} onChange={(e) => field("organizationId", e.target.value)}>
        <option value="">選択してください</option>
        {configuration.organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
      </select></label>
      <label>Cloudflare Team domain <input required placeholder="example.cloudflareaccess.com" value={draft.teamDomain}
        onChange={(e) => setDraft((old) => ({ ...old, teamDomain: e.target.value.trim().toLowerCase(), oidcClientId: "" }))} /></label>
      <label>Application AUD <input required pattern="[a-f0-9]{64}" maxLength={64} value={draft.audience}
        onChange={(e) => field("audience", e.target.value.trim().toLowerCase())} /></label>
      {callback && <p style={{ overflowWrap: "anywhere" }}>OIDC の Redirect URI: <code>{callback}</code></p>}
      <label>専用 OIDC クライアント <select required value={draft.oidcClientId} onChange={(e) => field("oidcClientId", e.target.value)}>
        <option value="">選択してください</option>
        {eligibleClients.map((client) => <option key={client.clientId} value={client.clientId}>{client.name}{!client.isActive && "・無効"}</option>)}
      </select></label>
      <p><Link to="/oidc-clients" target="_blank" rel="noreferrer">OIDC クライアントを登録</Link>し、上記 Redirect URI のみを設定してください。登録後は一覧を再読み込みします。</p>
      <label><input type="checkbox" checked={draft.requireMfa} onChange={(e) => field("requireMfa", e.target.checked)} /> MFA を必須にする</label>
      <label>再認証までの上限（秒） <input type="number" required min={60} max={86400} step={1} value={draft.maxAuthenticationAge}
        onChange={(e) => field("maxAuthenticationAge", Number(e.target.value))} /></label>
      <label>企業セッションの上限（秒） <input type="number" required min={60} max={86400} step={1} value={draft.maxSessionSeconds}
        onChange={(e) => field("maxSessionSeconds", Number(e.target.value))} /></label>
      <label><input type="checkbox" checked={draft.isActive} onChange={(e) => field("isActive", e.target.checked)} /> 接続を有効にする</label>
      <p>保存すると、この接続の既存セッションは失効し、Cloudflare での再ログインが必要です。組織または Team domain を変更するとユーザー対応も解除されます。</p>
      <button className="primary" type="submit">接続設定を保存</button>
    </fieldset>
  </form>;
}
