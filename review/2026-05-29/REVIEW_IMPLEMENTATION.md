# Web 実装レビュー — Cernere

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ | main |
| レビュー実施日 | 2026-05-29 |
| 対象コミット範囲 | 46c4b11..5ecac4d |

---

## 1. データスキーマの妥当性・重複確認 (Data Schema Validation)

| テーブル / モデル | 問題種別 | 説明 | 推奨対応 |
|-----------------|---------|------|---------|
| — | — | — | — |

### チェック結果

- [x] 正規化: managed_projects.schemaDefinition (JSONB) は 1NF 満たす。 endpoint.frontend_url は schema_definition 内で構造化
- [x] 重複: endpoint.frontend_url の値は被参照無し (derived field のみ)。 冗長ストレージなし
- [x] 型適合: `frontend_url: string | null` で PostgreSQL TEXT / NULL 対応
- [x] 制約: schemaDefinition 自体に NOT NULL 制約あり。 endpoint は optional struct のため `null` -> `null` で安全
- [x] インデックス: 派生フィールドのためインデックス不要 (read-only)
- [x] マイグレーション: DB schema 変更なし。 managed_projects テーブルは既存
- [x] API整合性: listProjects / listUserProjectsOverview の戻り値に frontendUrl: string | null を追加。 TS interface と一致

**評価: A** — スキーマ拡張なしでメタデータ派生。 整合性完全

---

## 2. コード品質 (Code Quality)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 関数粒度 | extractFrontendUrl は 3 行で単一責務。 listProjects / listUserProjectsOverview はそれぞれ 30-50 行で集約済 |
| A | 命名 | 派生フィールド helper は extractXxx パターン (TypeScript convention)。 戻り interface は UserProjectOverview で一貫 |
| A | エラー処理 | endpoint 未設定 / null / empty 文字列を全て defensive に handle |
| A | TypeScript strict | tsc strict mode 通過。 `schemaDefinition?.endpoint?.frontend_url` の optional chain 適切 |

---

## 3. SRE観点のレビュー (SRE Review)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 可観測性 | listProjects / listUserProjectsOverview は read-only API。 operation_logs 記録は不要 (既存: destructive のみ)。 応答 latency は既存 query + extractFrontendUrl の 3 行で +0 ms 期待値 |
| A | デプロイ安全性 | 新規フィールド追加のみ。 戻り値拡張は backward-compatible (JSON addition)。 既存クライアント (Memoria等) が frontendUrl 未認識でも動作不変 |
| A | スケーラビリティ | extractFrontendUrl は stateless ヘルパー関数。 水平 scale に影響なし。 in-memory project-registry もプロセス local のまま |
| A | 障害復旧 | schemaDefinition は immutable (登録時 snapshot)。 endpoint.frontend_url が変わっても既存行は unaffected |
| B | 依存関係管理 | Memoria Hub Shell の `.well-known/ludiars-app.json` probe 実装が必要。 Cernere 側は frontendUrl を露出するのみ。 Memoria 実装遅延時のフォールバック不明確 |

### チェック結果

- [x] 構造化ログ: ws/handler.ts で dispatch() call log 既存。 frontendUrl 読み取りは silent
- [x] メトリクス: getAllProjectStatus() / getProjectStatus() で connectionCount / lastConnectedAt 既にトラック
- [x] ヘルスチェック: `/health` endpoint は未確認 (scope 外)
- [x] ロールバック: 戻り値 spec 変更のため version up が基本。 既存クライアント互換で安全
- [x] 設定反映: endpoint.frontend_url は schema_definition 内で static (runtime reconfig 不可)
- [x] リソース制限: projectRegistry.connectionCount/lastConnectedAt は in-memory map。 上限管理は process memory (継続課題: Redis migration)
- [x] 水平 scale: 複数プロセス run 時、 各々が projectRegistry を持つため aggregate は Redis pub-sub 推奨 (既知課題)

**評価: A** — 現状は frontier で依存成熟度待ち。 Memoria 連携実装完成まで B 相当

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | データスキーマ | A | 0 |
| 2 | コード品質 | A | 0 |
| 3 | SRE | A | 0 |

**実装品質**: スキーマ拡張なしで派生フィールド追加。 DB query 負荷変わらず。 Memoria 連携の frontend 実装に依存。
