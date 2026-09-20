/** Explicit CF subject-to-member assignments and project-scoped revocation. @implements SPEC-ENTERPRISE-ADMIN */
import { useState } from "react";
import type { EnterpriseConnection, EnterpriseConfiguration, EnterpriseMutation } from "./types";

export function IdentityForm({ connection, configuration, busy, save }: {
  connection: EnterpriseConnection; configuration: EnterpriseConfiguration; busy: boolean; save: EnterpriseMutation;
}) {
  const [userId, setUserId] = useState("");
  const [subject, setSubject] = useState("");
  const members = configuration.members.filter((member) => member.organizationId === connection.organizationId);
  const identities = configuration.identities.filter((identity) => identity.projectKey === connection.projectKey);
  return <section style={{ marginTop: "1.5rem" }}>
    <h3>ユーザー対応</h3>
    <p>Cloudflare のユーザー ID（subject）を組織メンバーに対応付けます。メールアドレスによる自動登録は行いません。</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      void save("save_identity", { projectKey: connection.projectKey, userId, cloudflareSubject: subject.trim(), isActive: true });
      setSubject("");
    }}>
      <fieldset disabled={busy} style={{ display: "grid", gap: "0.75rem", border: "1px solid var(--border)" }}>
        <legend>対応付け・再有効化</legend>
        <label>組織メンバー <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">選択してください</option>
          {members.map((member) => <option key={member.userId} value={member.userId}>{member.name} ({member.role})</option>)}
        </select></label>
        <label>Cloudflare subject（UUID） <input required autoComplete="off" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
        <button type="submit" className="primary">ユーザー対応を保存</button>
      </fieldset>
    </form>
    <ul>{identities.map((identity) => <li key={identity.userId} style={{ margin: "0.7rem 0", overflowWrap: "anywhere" }}>
      {members.find((member) => member.userId === identity.userId)?.name ?? identity.userId} — {identity.isActive ? "有効" : "失効済み"}{" "}
      <button disabled={busy || !identity.isActive} onClick={() => void save("revoke_user", { projectKey: connection.projectKey, userId: identity.userId })}>アクセスを失効</button>
    </li>)}</ul>
  </section>;
}
