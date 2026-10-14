/**
 * 企業認証の対応付けの提案 (Concordia spec/plan/2026-10-15-cf-cernere-sso.md Cr-2)。
 * Cloudflare 経由でログインしたが対応付けが無かった組織メンバーを並べ、確定で対応付けにする。
 * 確定にはこの端末のパスキーで確認する (save_identity と同じ action proof)。
 */

import type { EnterpriseConfiguration, EnterpriseConnection, EnterpriseMutation } from "./types";

export function SuggestionList({ connection, configuration, busy, save }: {
  connection: EnterpriseConnection;
  configuration: EnterpriseConfiguration;
  busy: boolean;
  save: EnterpriseMutation;
}) {
  const suggestions = (configuration.suggestions ?? []).filter((s) => s.projectKey === connection.projectKey);
  if (suggestions.length === 0) return null;
  return <section style={{ marginTop: "1.5rem" }}>
    <h3>対応付けの提案</h3>
    <p>Cloudflare 経由でログインしたものの、まだ対応付けの無い組織メンバーです。本人であることを確かめてから確定してください。</p>
    <ul style={{ listStyle: "none", padding: 0 }}>
      {suggestions.map((s) => <li key={s.subjectHash} style={{ borderTop: "1px solid var(--border)", padding: "0.5rem 0" }}>
        <strong>{s.name || s.userId}</strong>
        <span style={{ color: "var(--text-muted)" }}> — 最初: {new Date(s.firstSeenAt).toLocaleString()} / 最後: {new Date(s.lastSeenAt).toLocaleString()}</span>
        <button style={{ marginLeft: "0.75rem" }} disabled={busy}
          onClick={() => void save("accept_suggestion", { projectKey: s.projectKey, userId: s.userId, subjectHash: s.subjectHash })}>
          確定する
        </button>
      </li>)}
    </ul>
  </section>;
}
