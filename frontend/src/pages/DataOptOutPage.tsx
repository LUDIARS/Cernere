import { useState, useEffect, useCallback } from "react";
import { optouts, type DataOptOutItem } from "../lib/api";

/**
 * プラグインが宣言するデータカテゴリの定義。
 * 各サービスが拡張データをカテゴリ別に登録し、
 * ユーザーはカテゴリ単位でオプトアウト（データ削除）できる。
 *
 * 本来はサーバ側プラグインレジストリから取得するが、
 * コアプロファイルのカテゴリはここで静的に定義する。
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
  {
    serviceId: "core",
    serviceName: "Cernere コアプロファイル",
    categoryKey: "extra",
    label: "拡張データ",
    description: "プラグインから書き込まれた追加プロフィールデータ",
    fields: ["extra"],
  },
];

export function DataOptOutPage() {
  const [currentOptOuts, setCurrentOptOuts] = useState<DataOptOutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    optouts
      .list()
      .then(setCurrentOptOuts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const isOptedOut = useCallback(
    (serviceId: string, categoryKey: string) =>
      currentOptOuts.some(
        (o: DataOptOutItem) => o.serviceId === serviceId && o.categoryKey === categoryKey,
      ),
    [currentOptOuts],
  );

  const getOptOutDate = useCallback(
    (serviceId: string, categoryKey: string) => {
      const o = currentOptOuts.find(
        (o: DataOptOutItem) => o.serviceId === serviceId && o.categoryKey === categoryKey,
      );
      return o ? new Date(o.optedOutAt).toLocaleString("ja-JP") : null;
    },
    [currentOptOuts],
  );

  const handleOptOut = useCallback(
    async (cat: DataCategoryDef) => {
      const key = `${cat.serviceId}:${cat.categoryKey}`;
      if (!window.confirm(
        `「${cat.label}」のデータをオプトアウトしますか？\n\n該当データは完全に削除されます。この操作は元に戻せません。`,
      )) {
        return;
      }

      setProcessing(key);
      setMessage("");
      try {
        const result = await optouts.create({
          serviceId: cat.serviceId,
          categoryKey: cat.categoryKey,
          fields: cat.fields,
        });
        setCurrentOptOuts((prev: DataOptOutItem[]) => [...prev, result.optout]);
        setMessage(`「${cat.label}」をオプトアウトしました。データは削除されました。`);
      } catch (e) {
        setMessage(
          e instanceof Error ? e.message : "オプトアウトに失敗しました",
        );
      } finally {
        setProcessing(null);
      }
    },
    [],
  );

  const handleRevoke = useCallback(
    async (cat: DataCategoryDef) => {
      const key = `${cat.serviceId}:${cat.categoryKey}`;
      setProcessing(key);
      setMessage("");
      try {
        await optouts.remove({
          serviceId: cat.serviceId,
          categoryKey: cat.categoryKey,
        });
        setCurrentOptOuts((prev: DataOptOutItem[]) =>
          prev.filter(
            (o: DataOptOutItem) =>
              !(
                o.serviceId === cat.serviceId &&
                o.categoryKey === cat.categoryKey
              ),
          ),
        );
        setMessage(`「${cat.label}」のオプトアウトを撤回しました。`);
      } catch (e) {
        setMessage(
          e instanceof Error ? e.message : "撤回に失敗しました",
        );
      } finally {
        setProcessing(null);
      }
    },
    [],
  );

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </div>
    );
  }

  // サービスごとにグループ化
  const grouped = new Map<string, { serviceName: string; categories: DataCategoryDef[] }>();
  for (const cat of CORE_DATA_CATEGORIES) {
    const group = grouped.get(cat.serviceId) ?? {
      serviceName: cat.serviceName,
      categories: [],
    };
    group.categories.push(cat);
    grouped.set(cat.serviceId, group);
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "2rem" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* ヘッダー */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1.5rem",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
            データ管理・オプトアウト
          </h1>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <a href="/profile" style={{ fontSize: "0.875rem" }}>
              ← プロファイル
            </a>
            <a href="/" style={{ fontSize: "0.875rem" }}>
              ダッシュボード
            </a>
          </div>
        </div>

        {/* 説明 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "1.5rem",
            marginBottom: "1rem",
          }}
        >
          <h2
            style={{
              fontSize: "1rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "var(--text-muted)",
            }}
          >
            データオプトアウトについて
          </h2>
          <p
            style={{
              fontSize: "0.85rem",
              color: "var(--text-muted)",
              lineHeight: 1.7,
            }}
          >
            拡張データはカテゴリごとに管理されています。
            オプトアウトすると、該当カテゴリのデータは完全に削除され、
            以降そのカテゴリへのデータ書き込みもブロックされます。
            オプトアウトを撤回すると、新しいデータの書き込みが再度可能になりますが、
            削除済みのデータは復元されません。
          </p>
        </div>

        {/* メッセージ */}
        {message && (
          <div
            style={{
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              borderRadius: "var(--radius)",
              fontSize: "0.85rem",
              background: message.includes("失敗")
                ? "rgba(248, 81, 73, 0.1)"
                : "rgba(63, 185, 80, 0.1)",
              color: message.includes("失敗") ? "var(--red)" : "var(--green)",
              border: `1px solid ${message.includes("失敗") ? "var(--red)" : "var(--green)"}`,
            }}
          >
            {message}
          </div>
        )}

        {/* カテゴリ一覧 */}
        {[...grouped.entries()].map(([serviceId, group]) => (
          <div
            key={serviceId}
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "1.5rem",
              marginBottom: "1rem",
            }}
          >
            <h2
              style={{
                fontSize: "1rem",
                fontWeight: 600,
                marginBottom: "1rem",
                color: "var(--text-muted)",
              }}
            >
              {group.serviceName}
            </h2>

            {group.categories.map((cat) => {
              const opted = isOptedOut(cat.serviceId, cat.categoryKey);
              const optedDate = getOptOutDate(cat.serviceId, cat.categoryKey);
              const key = `${cat.serviceId}:${cat.categoryKey}`;
              const isProcessing = processing === key;

              return (
                <div
                  key={key}
                  style={{
                    padding: "1rem",
                    marginBottom: "0.75rem",
                    borderRadius: "var(--radius)",
                    border: `1px solid ${opted ? "var(--red)" : "var(--border)"}`,
                    background: opted
                      ? "rgba(248, 81, 73, 0.05)"
                      : "transparent",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: "0.95rem" }}>
                        {cat.label}
                      </strong>
                      {opted && (
                        <span
                          style={{
                            marginLeft: "0.5rem",
                            fontSize: "0.7rem",
                            padding: "0.1rem 0.4rem",
                            borderRadius: "8px",
                            background: "rgba(248, 81, 73, 0.15)",
                            color: "var(--red)",
                            fontWeight: 600,
                          }}
                        >
                          オプトアウト済み
                        </span>
                      )}
                    </div>
                    <div>
                      {opted ? (
                        <button
                          onClick={() => handleRevoke(cat)}
                          disabled={isProcessing}
                          style={{
                            fontSize: "0.8rem",
                            padding: "0.3rem 0.75rem",
                            borderRadius: "var(--radius)",
                            border: "1px solid var(--border)",
                            background: "var(--bg-surface)",
                            color: "var(--text)",
                            cursor: isProcessing ? "wait" : "pointer",
                          }}
                        >
                          {isProcessing ? "処理中..." : "撤回"}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleOptOut(cat)}
                          disabled={isProcessing}
                          className="danger"
                          style={{
                            fontSize: "0.8rem",
                            padding: "0.3rem 0.75rem",
                          }}
                        >
                          {isProcessing ? "処理中..." : "オプトアウト"}
                        </button>
                      )}
                    </div>
                  </div>
                  <p
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--text-muted)",
                      margin: 0,
                    }}
                  >
                    {cat.description}
                  </p>
                  {opted && optedDate && (
                    <p
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-muted)",
                        margin: "0.25rem 0 0 0",
                      }}
                    >
                      オプトアウト日時: {optedDate}
                    </p>
                  )}
                  <p
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-muted)",
                      margin: "0.25rem 0 0 0",
                    }}
                  >
                    対象フィールド: {cat.fields.join(", ")}
                  </p>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
