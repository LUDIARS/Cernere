import { useEffect, useState } from "react";
import { parseLoginSettings, readLoginSettings, withLoginSettings } from "./project-login-settings";

interface Props {
  /** 管理者が見ているサービスの今の定義 (managed_project get の schemaDefinition)。 */
  definition: Record<string, unknown>;
  /** 定義を保存する (managed_project update_schema)。失敗は例外で返す。 */
  onSave: (definition: Record<string, unknown>) => Promise<void>;
}

/**
 * ログインの戻り先 (composite_origins) と PASETO の aud (hub_url) を、JSON を手で書かずに登録する欄。
 * どちらも管理者だけが登録できる項目 (server/src/project/admin-owned-fields.ts)。
 */
export function ProjectLoginSettingsPanel({ definition, onSave }: Props) {
  const current = readLoginSettings(definition);
  const [originsText, setOriginsText] = useState(current.compositeOrigins.join("\n"));
  const [hubUrlText, setHubUrlText] = useState(current.hubUrl ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const next = readLoginSettings(definition);
    setOriginsText(next.compositeOrigins.join("\n"));
    setHubUrlText(next.hubUrl ?? "");
  }, [definition]);

  const save = async () => {
    setSaved(false);
    const parsed = parseLoginSettings(originsText, hubUrlText);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await onSave(withLoginSettings(definition, parsed.settings));
      setSaved(true);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginBottom: "1rem", padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
      <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.25rem" }}>ログインの戻り先</h3>
      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
        このサービスの画面から Cernere でログインしたあと、戻ってよいオリジン (composite_origins)。
        1 行に 1 つ、https のオリジンで書きます (例 https://example.com)。ここに無い先へは戻しません。
      </p>
      <textarea
        aria-label="ログインの戻り先"
        value={originsText}
        onChange={(e) => setOriginsText(e.target.value)}
        rows={3}
        style={{
          width: "100%", padding: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem", borderRadius: "4px",
          border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box", resize: "vertical",
        }}
      />
      <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, margin: "0.75rem 0 0.25rem" }}>
        hub_url (サービス向け PASETO の aud)
      </label>
      <input
        aria-label="hub_url"
        value={hubUrlText}
        onChange={(e) => setHubUrlText(e.target.value)}
        placeholder="https://example.com"
        style={{
          width: "100%", padding: "0.4rem 0.5rem", fontFamily: "monospace", fontSize: "0.8rem", borderRadius: "4px",
          border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box",
        }}
      />
      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
        サービスがトークンを検証するときの aud (例 Ludellus-Server の CERNERE_PASETO_AUDIENCE) と同じ値にします。
        一度登録した hub_url は、空にしても消えません。
      </p>
      {errors.length > 0 && (
        <ul style={{ fontSize: "0.8rem", color: "var(--red)", margin: "0.5rem 0", paddingLeft: "1.25rem" }}>
          {errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
        <button className="primary" onClick={save} disabled={saving}>{saving ? "保存しています…" : "保存"}</button>
        {saved && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>保存しました</span>}
      </div>
    </div>
  );
}
