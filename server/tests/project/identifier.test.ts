import { describe, it, expect } from "vitest";
import { assertSafeIdentifier, MAX_IDENTIFIER_LENGTH } from "../../src/project/identifier";

describe("project/identifier — assertSafeIdentifier", () => {
  it("accepts legitimate snake_case column names from real seed definitions", () => {
    // 016/019/024 等の seed に実在する列名 (これらは弾いてはいけない)。
    const real = [
      "show_floating_button", "disable_tracking", "right", "bottom",
      "enabled", "default_top_k", "auto_backfill", "extra_ng_words",
      "extra_ng_domains", "language", "backend", "model", "device",
      "working_directory", "timeout", "name", "triggers", "prompt",
      "theme", "show_transcript", "auto_listen", "disabled",
      "biometric_face",
    ];
    for (const col of real) {
      expect(() => assertSafeIdentifier(col, "column")).not.toThrow();
    }
  });

  it("accepts derived table names (project_data_<key>)", () => {
    expect(() => assertSafeIdentifier("project_data_memoria", "table")).not.toThrow();
    expect(() => assertSafeIdentifier("project_data_imperativus", "table")).not.toThrow();
  });

  it("accepts leading underscore and digits after the first char", () => {
    expect(() => assertSafeIdentifier("_private", "column")).not.toThrow();
    expect(() => assertSafeIdentifier("col_1", "column")).not.toThrow();
  });

  it("rejects a name containing a double-quote (quote-break injection)", () => {
    expect(() => assertSafeIdentifier(`evil" ; DROP TABLE users; --`, "column")).toThrow(/invalid column identifier/);
  });

  it("rejects names with spaces, dashes, or punctuation", () => {
    expect(() => assertSafeIdentifier("has space", "column")).toThrow();
    expect(() => assertSafeIdentifier("has-dash", "column")).toThrow();
    expect(() => assertSafeIdentifier("col;", "column")).toThrow();
    expect(() => assertSafeIdentifier("col()", "column")).toThrow();
  });

  it("rejects a name starting with a digit", () => {
    expect(() => assertSafeIdentifier("1col", "column")).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => assertSafeIdentifier("", "column")).toThrow(/empty/);
  });

  it("rejects a name longer than the PostgreSQL identifier limit", () => {
    const tooLong = "a".repeat(MAX_IDENTIFIER_LENGTH + 1);
    expect(() => assertSafeIdentifier(tooLong, "column")).toThrow(/exceeds/);
    const atLimit = "a".repeat(MAX_IDENTIFIER_LENGTH);
    expect(() => assertSafeIdentifier(atLimit, "column")).not.toThrow();
  });

  it("rejects reserved DDL/DML keywords case-insensitively", () => {
    for (const word of ["select", "DROP", "Table", "users", "delete"]) {
      expect(() => assertSafeIdentifier(word, "column")).toThrow(/reserved word/);
    }
  });
});
