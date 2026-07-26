import { useEffect, useMemo, useState } from "react";

export interface ManagedSchemaColumn {
  type: string;
  module?: string;
  nullable?: boolean;
  description?: string;
  _deleted?: boolean;
}

export interface ManagedSchemaDataShare {
  project_key: string;
  access?: "read" | "readwrite";
  modules?: string[];
  columns?: string[];
  description?: string;
}

export interface ManagedSchemaDefinition {
  project: { key: string; name: string; description?: string };
  endpoint?: {
    url: string;
    frontend_url?: string;
    same_server?: boolean;
    bridge_path?: string;
  };
  data_sharing?: ManagedSchemaDataShare[];
  user_data?: { columns: Record<string, ManagedSchemaColumn> };
}

export interface ManagedProjectOption {
  key: string;
  name: string;
  isActive: boolean;
}

interface ShareDraft {
  projectKey: string;
  access: "read" | "readwrite";
  columns: string[];
  description: string;
}

interface ManagedSchemaSharingEditorProps {
  definition: ManagedSchemaDefinition;
  isMobile: boolean;
  projects: ManagedProjectOption[];
  onSave: (definition: ManagedSchemaDefinition) => Promise<void>;
}

function activeColumns(definition: ManagedSchemaDefinition): Array<[string, ManagedSchemaColumn]> {
  return Object.entries(definition.user_data?.columns ?? {})
    .filter(([, column]) => !column._deleted);
}

function effectiveColumns(
  share: ManagedSchemaDataShare,
  columns: Array<[string, ManagedSchemaColumn]>,
): string[] {
  return columns
    .filter(([name, column]) => {
      if (share.modules?.length && (!column.module || !share.modules.includes(column.module))) {
        return false;
      }
      return share.columns === undefined || share.columns.includes(name);
    })
    .map(([name]) => name);
}

function createDrafts(definition: ManagedSchemaDefinition): ShareDraft[] {
  const columns = activeColumns(definition);
  return (definition.data_sharing ?? []).map((share) => ({
    projectKey: share.project_key,
    access: share.access ?? "read",
    columns: effectiveColumns(share, columns),
    description: share.description ?? "",
  }));
}

function groupColumns(
  columns: Array<[string, ManagedSchemaColumn]>,
): Array<[string, Array<[string, ManagedSchemaColumn]>]> {
  const groups = new Map<string, Array<[string, ManagedSchemaColumn]>>();
  for (const entry of columns) {
    const moduleName = entry[1].module ?? "default";
    groups.set(moduleName, [...(groups.get(moduleName) ?? []), entry]);
  }
  return [...groups.entries()];
}

const panelStyle = {
  marginBottom: "1rem",
  padding: "1rem",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
} as const;

const inputStyle = {
  width: "100%",
  padding: "0.4rem 0.5rem",
  fontSize: "0.82rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  boxSizing: "border-box",
} as const;

export function ManagedSchemaSharingEditor({
  definition,
  isMobile,
  projects,
  onSave,
}: ManagedSchemaSharingEditorProps) {
  const columns = useMemo(() => activeColumns(definition), [definition]);
  const columnGroups = useMemo(() => groupColumns(columns), [columns]);
  const [drafts, setDrafts] = useState<ShareDraft[]>(() => createDrafts(definition));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    setDrafts(createDrafts(definition));
    setMessage("");
    setSaveFailed(false);
  }, [definition]);

  const candidateProjects = projects
    .filter((project) => project.isActive && project.key !== definition.project.key);
  const availableProjects = projects
    .filter((project) => project.key !== definition.project.key);
  const usedProjects = new Set(drafts.map((draft) => draft.projectKey));
  const addableProjects = candidateProjects
    .filter((project) => !usedProjects.has(project.key));
  const duplicateTargets = new Set(
    drafts
      .map((draft) => draft.projectKey)
      .filter((key, index, values) => key && values.indexOf(key) !== index),
  );
  const invalid = drafts.some((draft) =>
    !draft.projectKey || draft.columns.length === 0 || duplicateTargets.has(draft.projectKey));

  function updateDraft(index: number, update: Partial<ShareDraft>) {
    setDrafts((current) => current.map((draft, draftIndex) =>
      draftIndex === index ? { ...draft, ...update } : draft));
    setMessage("");
    setSaveFailed(false);
  }

  function toggleColumn(index: number, columnName: string) {
    const selected = new Set(drafts[index]?.columns ?? []);
    if (selected.has(columnName)) selected.delete(columnName);
    else selected.add(columnName);
    updateDraft(index, { columns: [...selected] });
  }

  function addGrant() {
    const used = new Set(drafts.map((draft) => draft.projectKey));
    const projectKey = candidateProjects.find((project) => !used.has(project.key))?.key ?? "";
    setDrafts((current) => [
      ...current,
      { projectKey, access: "read", columns: [], description: "" },
    ]);
    setMessage("");
    setSaveFailed(false);
  }

  async function save() {
    if (invalid) return;
    setSaving(true);
    setMessage("");
    setSaveFailed(false);
    try {
      const dataSharing: ManagedSchemaDataShare[] = drafts.map((draft) => ({
        project_key: draft.projectKey,
        access: draft.access,
        columns: draft.columns,
        ...(draft.description ? { description: draft.description } : {}),
      }));
      await onSave({ ...definition, data_sharing: dataSharing });
      setMessage("参照可能カラムを更新しました。");
    } catch {
      setSaveFailed(true);
      setMessage("参照設定を保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={panelStyle}>
      <div style={{
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        justifyContent: "space-between",
        alignItems: isMobile ? "stretch" : "center",
        gap: "0.75rem",
        marginBottom: "0.75rem",
      }}>
        <div>
          <h3 style={{ fontSize: "0.9rem", fontWeight: 600, margin: 0 }}>
            Managed Schema Sharing
          </h3>
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0.25rem 0 0" }}>
            共有先プロジェクトが参照できるカラムを管理者が明示的に選択します。
          </p>
        </div>
        <button
          onClick={addGrant}
          disabled={addableProjects.length === 0}
          style={{
            padding: "0.35rem 0.75rem",
            fontSize: "0.8rem",
            borderRadius: "4px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text)",
            cursor: addableProjects.length ? "pointer" : "not-allowed",
          }}
        >
          + 共有先を追加
        </button>
      </div>

      {columns.length === 0 ? (
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
          共有対象にできる有効なカラムがありません。
        </p>
      ) : drafts.length === 0 ? (
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
          他プロジェクトへの参照許可はありません。
        </p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {drafts.map((draft, index) => (
            <article
              key={`${draft.projectKey}-${index}`}
              style={{
                padding: "0.75rem",
                border: `1px solid ${duplicateTargets.has(draft.projectKey) ? "var(--red)" : "var(--border)"}`,
                borderRadius: "6px",
                background: "var(--bg)",
              }}
            >
              <div style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "minmax(180px, 1fr) 150px auto",
                gap: "0.5rem",
                alignItems: "center",
              }}>
                <select
                  aria-label="共有先プロジェクト"
                  value={draft.projectKey}
                  onChange={(event) => updateDraft(index, { projectKey: event.target.value })}
                  style={inputStyle}
                >
                  <option value="">共有先を選択</option>
                  {availableProjects.map((project) => (
                    <option key={project.key} value={project.key}>
                      {project.name} ({project.key}){project.isActive ? "" : " — inactive"}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="共有アクセス"
                  value={draft.access}
                  onChange={(event) => updateDraft(index, {
                    access: event.target.value as "read" | "readwrite",
                  })}
                  style={inputStyle}
                >
                  <option value="read">参照のみ</option>
                  <option value="readwrite">参照・更新</option>
                </select>
                <button
                  onClick={() => setDrafts((current) =>
                    current.filter((_, draftIndex) => draftIndex !== index))}
                  style={{
                    padding: "0.35rem 0.65rem",
                    fontSize: "0.78rem",
                    borderRadius: "4px",
                    border: "1px solid var(--red, #f85149)",
                    background: "transparent",
                    color: "var(--red, #f85149)",
                    cursor: "pointer",
                  }}
                >
                  削除
                </button>
              </div>

              <div style={{ display: "grid", gap: "0.65rem", marginTop: "0.75rem" }}>
                {columnGroups.map(([moduleName, moduleColumns]) => (
                  <fieldset
                    key={moduleName}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: "4px",
                      padding: "0.5rem 0.65rem 0.65rem",
                    }}
                  >
                    <legend style={{ fontSize: "0.72rem", color: "var(--text-muted)", padding: "0 0.25rem" }}>
                      {moduleName}
                    </legend>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(210px, 1fr))",
                      gap: "0.4rem 0.75rem",
                    }}>
                      {moduleColumns.map(([columnName, column]) => (
                        <label
                          key={columnName}
                          title={column.description}
                          style={{ display: "flex", alignItems: "center", gap: "0.45rem", fontSize: "0.78rem" }}
                        >
                          <input
                            type="checkbox"
                            checked={draft.columns.includes(columnName)}
                            onChange={() => toggleColumn(index, columnName)}
                          />
                          <code>{columnName}</code>
                          <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                            {column.type}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>

              {draft.columns.length === 0 && (
                <p style={{ color: "var(--red)", fontSize: "0.72rem", margin: "0.5rem 0 0" }}>
                  参照を許可するカラムを1つ以上選択してください。
                </p>
              )}
              {duplicateTargets.has(draft.projectKey) && (
                <p style={{ color: "var(--red)", fontSize: "0.72rem", margin: "0.5rem 0 0" }}>
                  同じ共有先は1件にまとめてください。
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.75rem" }}>
        <button
          className="primary"
          onClick={save}
          disabled={saving || invalid}
          style={{ opacity: saving || invalid ? 0.5 : 1 }}
        >
          {saving ? "保存中..." : "参照設定を保存"}
        </button>
        {message && (
          <span
            role={saveFailed ? "alert" : "status"}
            style={{ color: saveFailed ? "var(--red)" : "var(--green)", fontSize: "0.78rem" }}
          >
            {message}
          </span>
        )}
      </div>
    </section>
  );
}
