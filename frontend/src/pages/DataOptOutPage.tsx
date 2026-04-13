import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { optouts, managedProjects, type DataOptOutItem, type UserProjectData } from "../lib/api";

/**
 * Cernere コアプロフィールのデータカテゴリ。
 */
interface DataCategoryDef {
  serviceId: string;
  serviceName: string;
  categoryKey: string;
  label: string;
  description: string;
  fields: string[];
}

const CORE_DATA_CATEGORIES: DataCategoryDef[] = [
  {
    serviceId: "core",
    serviceName: "Cernere コアプロファイル",
    categoryKey: "personality",
    label: "パーソナリティデータ",
    description: "役割、自己紹介、得意分野、趣味などのプロフィール情報",
    fields: ["roleTitle", "bio", "expertise", "hobbies"],
  },
];

export function DataOptOutPage() {
  const [currentOptOuts, setCurrentOptOuts] = useState<DataOptOutItem[]>([]);
  const [projectData, setProjectData] = useState<UserProjectData[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [opts, projs] = await Promise.all([
        optouts.list(),
        managedProjects.myDataAll().catch(() => []),
      ]);
      setCurrentOptOuts(opts);
      setProjectData(projs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isOptedOut = useCallback(
    (serviceId: string, categoryKey: string) =>
      currentOptOuts.some(
        (o) => o.serviceId === serviceId && o.categoryKey === categoryKey,
      ),
    [currentOptOuts],
  );

  const getOptOutDate = useCallback(
    (serviceId: string, categoryKey: string) => {
      const o = currentOptOuts.find(
        (o) => o.serviceId === serviceId && o.categoryKey === categoryKey,
      );
      return o ? new Date(o.optedOutAt).toLocaleString("ja-JP") : null;
    },
    [currentOptOuts],
  );

  const handleOptOut = useCallback(
    async (serviceId: string, categoryKey: string, label: string, fields?: string[]) => {
      const key = `${serviceId}:${categoryKey}`;
      if (!window.confirm(
        `「${label}」のデータをオプトアウトしますか？\n\n以降このカテゴリへのデータ書き込みがブロックされます。`,
      )) return;

      setProcessing(key);
      setMessage("");
      try {
        await optouts.create({ serviceId, categoryKey, fields });
        setMessage(`「${label}」をオプトアウトしました。`);
        await refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "オプトアウトに失敗しました");
      } finally {
        setProcessing(null);
      }
    },
    [refresh],
  );

  const handleRevoke = useCallback(
    async (serviceId: string, categoryKey: string, label: string) => {
      const key = `${serviceId}:${categoryKey}`;
      setProcessing(key);
      setMessage("");
      try {
        await optouts.remove({ serviceId, categoryKey });
        setMessage(`「${label}」のオプトアウトを撤回しました。`);
        await refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "撤回に失敗しました");
      } finally {
        setProcessing(null);
      }
    },
    [refresh],
  );

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "2rem" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        {/* ヘッダー */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>データ管理・オプトアウト</h1>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <Link to="/profile" style={{ fontSize: "0.875rem" }}>← プロファイル</Link>
            <Link to="/" style={{ fontSize: "0.875rem" }}>ダッシュボード</Link>
          </div>
        </div>

        {/* 説明 */}
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>
            データオプトアウトについて
          </h2>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.7 }}>
            各データカテゴリ・モジュールごとにオプトアウトできます。
            オプトアウトすると該当カテゴリへの書き込みがブロックされ、
            既存データは削除されます。オプトアウトを撤回すると書き込みが再度可能になりますが、
            削除済みのデータは復元されません。
          </p>
        </div>

        {/* メッセージ */}
        {message && (
          <div style={{
            padding: "0.75rem 1rem", marginBottom: "1rem", borderRadius: "var(--radius)", fontSize: "0.85rem",
            background: message.includes("失敗") ? "rgba(248, 81, 73, 0.1)" : "rgba(63, 185, 80, 0.1)",
            color: message.includes("失敗") ? "var(--red)" : "var(--green)",
            border: `1px solid ${message.includes("失敗") ? "var(--red)" : "var(--green)"}`,
          }}>
            {message}
          </div>
        )}

        {/* コアプロファイル */}
        <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem", color: "var(--text-muted)" }}>
            Cernere コアプロファイル
          </h2>
          {CORE_DATA_CATEGORIES.map((cat) => {
            const opted = isOptedOut(cat.serviceId, cat.categoryKey);
            const optedDate = getOptOutDate(cat.serviceId, cat.categoryKey);
            const key = `${cat.serviceId}:${cat.categoryKey}`;
            const isProcessing = processing === key;
            return (
              <CategoryCard
                key={key}
                label={cat.label}
                description={cat.description}
                fieldsText={`対象フィールド: ${cat.fields.join(", ")}`}
                opted={opted}
                optedDate={optedDate}
                isProcessing={isProcessing}
                onOptOut={() => handleOptOut(cat.serviceId, cat.categoryKey, cat.label, cat.fields)}
                onRevoke={() => handleRevoke(cat.serviceId, cat.categoryKey, cat.label)}
              />
            );
          })}
        </section>

        {/* プロジェクト (登録済みプロジェクト) */}
        <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem", color: "var(--text-muted)" }}>
            プロジェクト
          </h2>
          {projectData.length === 0 ? (
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
              登録済みプロジェクトはありません。
            </p>
          ) : (
            projectData.map((proj) => {
              const modules = groupByModule(proj.schema);
              return (
                <div key={proj.projectKey} style={{ marginBottom: "1rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
                  <div style={{ marginBottom: "0.75rem" }}>
                    <strong style={{ fontSize: "1rem" }}>{proj.projectName}</strong>
                    <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      <code>{proj.projectKey}</code>
                    </span>
                  </div>

                  {Object.keys(modules).length === 0 ? (
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>データ項目が定義されていません。</p>
                  ) : (
                    Object.entries(modules).map(([moduleName, cols]) => {
                      const moduleKey = `module:${moduleName}`;
                      const opted = isOptedOut(proj.projectKey, moduleKey);
                      const optedDate = getOptOutDate(proj.projectKey, moduleKey);
                      const procKey = `${proj.projectKey}:${moduleKey}`;
                      const isProcessing = processing === procKey;

                      return (
                        <CategoryCard
                          key={procKey}
                          label={moduleName || "未分類"}
                          description={`保持データ: ${cols.map((c) => c.name).join(", ")}`}
                          fieldsText={renderCurrentData(cols, proj.data)}
                          opted={opted}
                          optedDate={optedDate}
                          isProcessing={isProcessing}
                          onOptOut={() => handleOptOut(proj.projectKey, moduleKey, `${proj.projectName} / ${moduleName}`)}
                          onRevoke={() => handleRevoke(proj.projectKey, moduleKey, `${proj.projectName} / ${moduleName}`)}
                        />
                      );
                    })
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function groupByModule(
  schema: UserProjectData["schema"],
): Record<string, Array<{ name: string; type: string; description?: string }>> {
  const modules: Record<string, Array<{ name: string; type: string; description?: string }>> = {};
  for (const [name, col] of Object.entries(schema)) {
    const mod = col.module ?? "default";
    if (!modules[mod]) modules[mod] = [];
    modules[mod].push({ name, type: col.type, description: col.description });
  }
  return modules;
}

function renderCurrentData(
  cols: Array<{ name: string; type: string }>,
  data: Record<string, unknown> | null,
): string {
  if (!data) return "現在の値: (未保存)";
  const parts: string[] = [];
  for (const c of cols) {
    const v = data[c.name];
    if (v !== undefined && v !== null) {
      const display = typeof v === "object" ? JSON.stringify(v) : String(v);
      parts.push(`${c.name}=${display.length > 30 ? display.slice(0, 30) + "..." : display}`);
    }
  }
  return parts.length > 0 ? `現在の値: ${parts.join(" / ")}` : "現在の値: (未保存)";
}

function CategoryCard(props: {
  label: string;
  description: string;
  fieldsText?: string;
  opted: boolean;
  optedDate: string | null;
  isProcessing: boolean;
  onOptOut: () => void;
  onRevoke: () => void;
}) {
  const { label, description, fieldsText, opted, optedDate, isProcessing, onOptOut, onRevoke } = props;
  return (
    <div style={{
      padding: "1rem", marginBottom: "0.75rem", borderRadius: "var(--radius)",
      border: `1px solid ${opted ? "var(--red)" : "var(--border)"}`,
      background: opted ? "rgba(248, 81, 73, 0.05)" : "transparent",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <div>
          <strong style={{ fontSize: "0.95rem" }}>{label}</strong>
          {opted && (
            <span style={{
              marginLeft: "0.5rem", fontSize: "0.7rem", padding: "0.1rem 0.4rem",
              borderRadius: "8px", background: "rgba(248, 81, 73, 0.15)",
              color: "var(--red)", fontWeight: 600,
            }}>
              オプトアウト済み
            </span>
          )}
        </div>
        <div>
          {opted ? (
            <button onClick={onRevoke} disabled={isProcessing} style={{
              fontSize: "0.8rem", padding: "0.3rem 0.75rem", borderRadius: "var(--radius)",
              border: "1px solid var(--border)", background: "var(--bg-surface)",
              color: "var(--text)", cursor: isProcessing ? "wait" : "pointer",
            }}>
              {isProcessing ? "処理中..." : "撤回"}
            </button>
          ) : (
            <button onClick={onOptOut} disabled={isProcessing} className="danger"
              style={{ fontSize: "0.8rem", padding: "0.3rem 0.75rem" }}>
              {isProcessing ? "処理中..." : "オプトアウト"}
            </button>
          )}
        </div>
      </div>
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>{description}</p>
      {opted && optedDate && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0.25rem 0 0 0" }}>
          オプトアウト日時: {optedDate}
        </p>
      )}
      {fieldsText && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0.25rem 0 0 0" }}>
          {fieldsText}
        </p>
      )}
    </div>
  );
}
