/**
 * <CompositeLogin> 系コンポーネントで共有するインラインスタイル。
 * CSS 変数 (--accent 等) は利用側テーマから継承し、 無ければ既定色に落ちる。
 */

import type { CSSProperties } from "react";

export const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  color: "var(--text-muted, #888)",
  marginBottom: "0.25rem",
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid var(--border, #ccc)",
  borderRadius: "4px",
  background: "var(--bg, #fff)",
  color: "var(--text, #000)",
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

export function primaryButtonStyle(busy: boolean): CSSProperties {
  return {
    width: "100%",
    marginTop: "0.5rem",
    padding: "0.6rem",
    background: "var(--accent, #4f46e5)",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    fontWeight: 600,
    cursor: busy ? "wait" : "pointer",
  };
}

/** 主ボタンの下に置く、 下線リンク風の控えめなボタン */
export function linkButtonStyle(busy: boolean): CSSProperties {
  return {
    width: "100%",
    marginTop: "0.5rem",
    padding: "0.4rem",
    background: "transparent",
    color: "var(--accent, #4f46e5)",
    border: "none",
    fontSize: "0.85rem",
    cursor: busy ? "wait" : "pointer",
    textDecoration: "underline",
  };
}

/** タブ切替やモード切替に使う、 テキストだけの小さなボタン */
export const subtleLinkStyle: CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--text-muted, #888)",
  textDecoration: "underline",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};

export const hintStyle: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "0.75rem",
  color: "var(--text-muted, #888)",
};

/** OAuth / パスキーなど、 主フォームと並ぶ代替導線の横長ボタン */
export function secondaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    width: "100%",
    padding: "0.6rem",
    background: "var(--bg-surface-2, #f3f4f6)",
    border: "1px solid var(--border, #ccc)",
    borderRadius: "4px",
    color: "var(--text, #000)",
    fontSize: "0.875rem",
    textDecoration: "none",
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

export const oauthBtnStyle: CSSProperties = secondaryButtonStyle(false);
