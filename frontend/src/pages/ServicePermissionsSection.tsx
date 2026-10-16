/**
 * 「サービスの権限」— 同意したサービスごとの権限の見直し (/data-optout の上段)。
 *
 * 推奨の許可を変える (consent.decide) と、同意の取り消し = そのサービスの利用停止 (consent.revoke)。
 * どちらも本人確認 (パスキーの action proof) を通す。必須は外せない (外したいときは利用停止)。
 * サービスが入力項目 (signup_fields) を宣言していれば「<サービス名> で使う情報」も同じ保存で直せる
 * (spec/plan/2026-10-15-service-signup-fields-design.md §3)。
 */

import { useCallback, useEffect, useState } from "react";
import { PermissionList, initialRecommendedSelection } from "../components/consent/PermissionList";
import { SignupFieldsForm } from "../components/signup-fields/SignupFieldsForm";
import { serviceConsents, type ServiceConsentItem } from "../lib/consent-api";
import { initialSignupValues, type SignupFieldErrors, type SignupFieldValue } from "../lib/signup-fields-api";

function itemKey(item: Pick<ServiceConsentItem, "subjectKind" | "subjectKey">): string {
  return `${item.subjectKind}:${item.subjectKey}`;
}

function ServiceConsentCard(props: { item: ServiceConsentItem; onChanged: (item: ServiceConsentItem) => void }) {
  const { item, onChanged } = props;
  const [selected, setSelected] = useState<Set<string>>(() => initialRecommendedSelection(item.view));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [values, setValues] = useState<Record<string, SignupFieldValue>>(() => initialSignupValues(item.signupFields?.fields ?? []));
  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
  const revoked = item.revokedAt !== null;

  useEffect(() => {
    setSelected(initialRecommendedSelection(item.view));
    setValues(initialSignupValues(item.signupFields?.fields ?? []));
  }, [item]);

  const run = async (kind: "decide" | "revoke") => {
    if (kind === "revoke" && !window.confirm(
      `「${item.serviceName}」の利用を停止しますか？\n\nこのサービスへ渡す情報を止め、次にログインするときにもう一度確認します。`,
    )) return;
    setBusy(true);
    setMessage("");
    setFieldErrors({});
    try {
      const updated = kind === "decide"
        ? await serviceConsents.decide(item, [...selected], item.signupFields ? values : undefined)
        : await serviceConsents.revoke(item);
      if ("fieldErrors" in updated) {
        setFieldErrors(updated.fieldErrors);
        setMessage("入力内容を確認してください。");
        return;
      }
      onChanged(updated);
      setMessage(kind === "decide" ? "保存しました。" : "利用を停止しました。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "1rem", marginBottom: "0.75rem", borderRadius: "var(--radius)", border: `1px solid ${revoked ? "var(--red)" : "var(--border)"}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 0.5rem", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.serviceName}</strong>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {revoked ? `利用停止: ${new Date(item.revokedAt!).toLocaleString("ja-JP")}`
            : item.decidedAt ? `確認: ${new Date(item.decidedAt).toLocaleString("ja-JP")}` : ""}
        </span>
      </div>
      <PermissionList
        view={item.view}
        selected={selected}
        disabled={busy}
        onToggle={(key, checked) => setSelected((prev) => {
          const next = new Set(prev);
          if (checked) next.add(key); else next.delete(key);
          return next;
        })}
      />
      {item.signupFields && !revoked && (
        <SignupFieldsForm
          serviceName={item.serviceName}
          fields={item.signupFields.fields}
          values={values}
          errors={fieldErrors}
          disabled={busy}
          onChange={(column, value) => setValues((prev) => ({ ...prev, [column]: value }))}
        />
      )}
      {message && <p role="status" style={{ fontSize: "0.8rem", margin: "0 0 0.5rem" }}>{message}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "flex-end" }}>
        {!revoked && (
          <button type="button" className="danger" disabled={busy} onClick={() => void run("revoke")}
            style={{ fontSize: "0.8rem", padding: "0.3rem 0.75rem" }}>
            利用を停止
          </button>
        )}
        <button type="button" className="primary" disabled={busy} onClick={() => void run("decide")}
          style={{ fontSize: "0.8rem", padding: "0.3rem 0.75rem" }}>
          {revoked ? "許可して再開" : item.signupFields ? "保存" : "推奨の選択を保存"}
        </button>
      </div>
    </div>
  );
}

export function ServicePermissionsSection() {
  const [items, setItems] = useState<ServiceConsentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setItems(await serviceConsents.list());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const replace = (updated: ServiceConsentItem) => {
    setItems((prev) => prev.map((item) => itemKey(item) === itemKey(updated) ? updated : item));
  };

  return (
    <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", marginBottom: "1rem" }}>
      <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>
        ログインしたサービスの権限
      </h2>
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "1rem", lineHeight: 1.6 }}>
        初めてログインしたときに確認した権限です。推奨は外せます。必須を外したいときは利用を停止してください。
      </p>
      {loading ? (
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Loading...</p>
      ) : error ? (
        <p style={{ fontSize: "0.85rem", color: "var(--red)" }}>{error}</p>
      ) : items.length === 0 ? (
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>権限を確認したサービスはまだありません。</p>
      ) : (
        items.map((item) => <ServiceConsentCard key={itemKey(item)} item={item} onChanged={replace} />)
      )}
    </section>
  );
}
