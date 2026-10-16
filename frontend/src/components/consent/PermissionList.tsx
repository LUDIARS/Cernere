/**
 * 権限の一覧 (必須 / 推奨・目的・誰が読めるか)。/consent・/oidc/consent・サービスの権限で共通に使う。
 *
 * - 必須はチェック固定。推奨はチェックボックス (既定オフ、利用者が選んで入れる)。
 * - 本人以外 (他の利用者・他のサービス・公開) に届く行は目立つ印を付ける。
 * - 再確認では前回から増えた権限を「新規」で強調する。
 */

import type { CSSProperties } from "react";
import type { ConsentPermissionView, ConsentView } from "../../lib/consent-api";
import { audienceLabel, audienceSource, permissionLabel } from "./consent-labels";

const rowStyle: CSSProperties = {
  display: "flex", gap: "0.6rem", alignItems: "flex-start", padding: "0.55rem 0",
  borderTop: "1px solid var(--border)", fontSize: "0.85rem",
};
const badge = (color: string): CSSProperties => ({
  fontSize: "0.68rem", padding: "0.05rem 0.4rem", borderRadius: "8px",
  border: `1px solid ${color}`, color, whiteSpace: "nowrap",
});

function PermissionRow(props: {
  permission: ConsentPermissionView;
  checked: boolean;
  locked: boolean;
  onToggle?: (key: string, checked: boolean) => void;
}) {
  const { permission, checked, locked, onToggle } = props;
  return (
    <li style={rowStyle}>
      <input
        type="checkbox"
        aria-label={permissionLabel(permission)}
        checked={checked}
        disabled={locked}
        onChange={(e) => onToggle?.(permission.key, e.target.checked)}
        style={{ width: "1rem", height: "1rem", flex: "0 0 1rem", margin: "0.2rem 0 0", padding: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0.25rem 0.4rem", fontWeight: 600 }}>
          <span style={{ minWidth: 0 }}>{permissionLabel(permission)}</span>
          {permission.sharedBeyondSelf && <span style={badge("var(--red)")} title="あなた以外も読めます">他の人も読める</span>}
          {permission.isNew && <span style={badge("var(--accent)")}>新規</span>}
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: "0.15rem" }}>
          目的: {permission.purpose ?? "サービスが目的を申告していません"}
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: "0.15rem" }}>
          誰が読めるか: {permission.visibleTo.length === 0
            ? (permission.key === "identity.basic" ? "このサービス" : "サービスが申告していません")
            : permission.visibleTo.map((v) => `${audienceLabel(v)} (${audienceSource(v)})`).join(" / ")}
        </div>
        {permission.privacyDependent && (
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
            プロフィールの公開設定が「公開」のときだけ、サービスに渡ります。
          </div>
        )}
      </div>
    </li>
  );
}

export function PermissionList(props: {
  view: ConsentView;
  /** チェックが入っている推奨の権限キー */
  selected: ReadonlySet<string>;
  onToggle: (key: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const { view, selected, onToggle, disabled } = props;
  return (
    <div>
      <p style={{ fontSize: "0.85rem", fontWeight: 600, margin: "0 0 0.25rem" }}>必須 (許可しないと利用できません)</p>
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem" }}>
        {view.required.map((p) => <PermissionRow key={p.key} permission={p} checked locked />)}
      </ul>
      {view.recommended.length > 0 && (
        <>
          <p style={{ fontSize: "0.85rem", fontWeight: 600, margin: "0 0 0.25rem" }}>推奨 (外しても利用できます)</p>
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem" }}>
            {view.recommended.map((p) => (
              <PermissionRow key={p.key} permission={p} checked={selected.has(p.key)} locked={!!disabled} onToggle={onToggle} />
            ))}
          </ul>
        </>
      )}
      {!view.declared && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          このサービスは権限の目的を申告していません。管理者が許可した範囲を推奨として表示しています。
        </p>
      )}
    </div>
  );
}

/** 推奨の初期選択: 前回許可したものだけ入れる (既定オフ)。 */
export function initialRecommendedSelection(view: ConsentView): Set<string> {
  return new Set(view.recommended.filter((p) => p.decision === "granted").map((p) => p.key));
}
