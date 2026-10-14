/** パスキーのみ認証の画面 (オンボーディング・/security・/recover) で共用するスタイル。 */

import type { CSSProperties } from "react";

export const panelStyle: CSSProperties = {
  background: "var(--bg-surface-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "1.5rem",
  marginTop: "1rem",
};

export const panelTitleStyle: CSSProperties = {
  fontSize: "1rem",
  fontWeight: 600,
  marginBottom: "0.5rem",
};

export const bodyTextStyle: CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--text-muted)",
  lineHeight: 1.7,
  marginBottom: "0.75rem",
};

export function primaryButton(disabled: boolean): CSSProperties {
  return {
    fontSize: "0.9rem",
    padding: "0.5rem 1.1rem",
    borderRadius: "var(--radius)",
    border: "1px solid var(--accent)",
    background: "var(--accent)",
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

export function secondaryButton(disabled: boolean): CSSProperties {
  return {
    fontSize: "0.9rem",
    padding: "0.5rem 1.1rem",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.55rem 0.75rem",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "1rem",
  boxSizing: "border-box",
};

export function messageStyle(isError: boolean): CSSProperties {
  return { fontSize: "0.85rem", margin: "0.5rem 0", color: isError ? "var(--red)" : "var(--green)" };
}

export const pageStyle: CSSProperties = {
  maxWidth: "36rem",
  margin: "2.5rem auto",
  padding: "0 1rem",
};
