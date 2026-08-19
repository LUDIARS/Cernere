/**
 * <LoginDivider>
 *
 * ログインカード内で「主たる導線」と「代替の導線」を隔てる水平線つきラベル。
 * OAuth ボタン群と、 利用側が差し込む代替導線 (パスキー等) の双方が同じ
 * 見た目になるよう、 CompositeLogin から切り出して共有する。
 */

import type { ReactElement } from "react";

export interface LoginDividerProps {
  /** 線の間に挟む文言 (「または」 等) */
  label: string;
}

/** @implements SPEC-COMPOSITE-AUTH-ALTERNATIVES */
export function LoginDivider({ label }: LoginDividerProps): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        margin: "1.25rem 0",
        color: "var(--text-muted, #888)",
        fontSize: "0.8rem",
      }}
    >
      <div style={{ flex: 1, height: 1, background: "var(--border, #ccc)" }} />
      <span>{label}</span>
      <div style={{ flex: 1, height: 1, background: "var(--border, #ccc)" }} />
    </div>
  );
}
