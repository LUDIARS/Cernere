# 不足機能評価 — Cernere

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ | main |
| レビュー実施日 | 2026-05-29 |
| 対象コミット範囲 | 46c4b11..5ecac4d |

---

## 1. 機能の改善提案 (Feature Improvement)

| 対象機能 | 改善提案 | 期待効果 | 優先度 |
|---------|---------|---------|--------|
| project.list / overview | endpoint 更新時に既存 project rows の frontendUrl を同期 | Hub Shell が UI 再検証時に old URL を probe するリスク排除 | Medium |
| project.overview | endpoint.frontend_url の妥当性 (URL format / reachability) を daemon-level check | manifest probe 失敗時のデバッグ時間削減 | Low |

### 観点

- endpoint.frontend_url は schema_definition 登録時に1度きり。 実運用で endpoint change があれば project re-register が必要 (現状は design by intent)
- Memoria Hub Shell 側が probe retry / fallback を持つか未確認。 Cernere 側での defensive check が必要か design review 推奨

---

## 2. 不足機能の提案 (Missing Feature Proposal)

| 提案機能 | 必要性の根拠 | 実装優先度 | 想定影響範囲 |
|---------|------------|-----------|------------|
| endpoint.frontend_url の input validation | endpoint URL が malformed (not https / not a valid domain) の場合、 service unavailable になる可能性。 schema.ts で `z.string().url()` validation を追加 | High | server/src/project/schema.ts / schema-migrator.ts |
| endpoint reachability check (non-blocking) | endpoint.frontend_url が指す URL が alive か定期確認。 dead link 検出後は dashboard に警告表示 | Medium | project-registry.ts / health check endpoint |
| Hub Shell manifest probe の error handling 仕様化 | Memoria が `<origin>/.well-known/ludiars-app.json` probe に失敗時の retry / fallback 仕様を Cernere spec に明記 | Medium | spec/project-management.md |

### 観点

- 現状 frontendUrl: null 値で Hub Shell が skip する設計は graceful だが、 endpoint 定義エラー (typo / 存在しない URL) は silent failure
- spec/project-management.md に endpoint validation ルール (https 必須 / domain whitelist 等) を記載推奨

---

## 総合評価

| # | レビュー観点 | 指摘数 | 優先度別内訳 |
|---|------------|--------|------------|
| 1 | 機能改善 | 2 | High: 0 / Medium: 1 / Low: 1 |
| 2 | 不足機能 | 3 | High: 1 / Medium: 2 / Low: 0 |
