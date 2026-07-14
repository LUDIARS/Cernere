# 設計レビュー — Cernere (LUDIARS 認証 / ID 基盤)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ | main |
| レビュー実施日 | 2026-05-29 |
| 対象コミット範囲 | 46c4b11..5ecac4d |

---

## 1. 設計強度 (Design Robustness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 障害分離 | 常時接続 WebSocket セッションによる単一障害点排除。 4 層防御体系が確立。 新規 frontendUrl フィールドはメタデータ性で既存レジストリ設計に副次的 |
| A | 冪等性 | 認証・リソース所有権チェック層が不変。 frontendUrl は DB read-only の派生値で破壊的操作なし |
| A | 入力バリデーション | 新規フィールド `endpoint.frontend_url` は schema-migrator.ts の Zod validateProjectSchema により入力時に validate 済み。 runtime の `typeof` ガードで空文字列も除外 |
| A | エラーハンドリング | リレー / ユーザデータ API 層と同じパターン: null は null 返却で異常値でない設計 |
| A | リトライ・タイムアウト設計 | API 戻り値の expand-only 設計のため timeout 機構不要。 取得 API 自体の timeout は既存 (変更なし) |
| A | 状態管理の明確性 | frontendUrl は派生フィールド (schemaDefinition.endpoint.frontend_url より計算)、 状態管理ポイント増加なし |

### チェック結果

- [x] 単一障害点: WebSocket 常時接続が SPOF 対策。 endpoint 未設定時も graceful (null)
- [x] 外部障害時縮退: Memoria Hub Shell が frontendUrl=null のプロジェクトをスキップ (仕様で明記)
- [x] 入力境界値: 空文字列除外、 URL 形式チェックは endpoint 登録時の責務
- [x] エラー状態遷移: 403 / 401 / null いずれもレイヤー通りで安全
- [x] 非同期処理: listProjects / listUserProjectsOverview 両者とも await 式のみで競合状態なし

**評価: A** — 新規機能が既存堅牢設計に調和している

---

## 2. 設計思想の一貫性 (Design Philosophy Compliance)

| 該当箇所 | 逸脱内容 | 本来の設計思想 | 推奨修正 |
|----------|---------|--------------|---------|
| `server/src/project/service.ts:27-29` | extractFrontendUrl() の `typeof` ガード | schema_definition は既に Zod で validate されており、 runtime guard は "defense in depth" | 現行で問題なし。 スキーマ進化に耐える設計 |

CLAUDE.md の設計ルール (§1.2 Step 6: 破壊的操作の防御層) と整合:
- Layer 1 (Token 検証) — list/overview の呼び出し前に既に実施
- Layer 2 (Redis TTL) — 変更なし
- Layer 3 (state check) — 変更なし
- Layer 4 (ownership) — frontendUrl は public read-only フィールド、 権限チェック不要

**評価: A** — LUDIARS 基盤設計ルール完全準拠

---

## 3. モジュール分割度 / 機能的凝集度 (Cohesion & Modularity)

| モジュール / クラス | 凝集度評価 | 所見 |
|-------------------|-----------|------|
| `extractFrontendUrl()` | 機能的 | 単一責務: endpoint.frontend_url 抽出。 3 行で完結。 テスト可能 |
| `listProjects()` | 機能的 | プロジェクト一覧取得 → status merge → frontendUrl 派生。 責務の粒度が明確 |
| `listUserProjectsOverview()` | 機能的 | ユーザデータ集計 → frontendUrl 派生。 既存 (totalColumns, inUse) と同質のメタデータ扱い |
| `UserProjectOverview` interface | 機能的 | 読み取り専用フィールド群。 リレーション・状態変化なし |

### チェック結果

- [x] SRP 違反: なし。 extractFrontendUrl は単一の責務
- [x] God Object: なし。 UserProjectOverview はフィールド増加のみで凝集度維持
- [x] 結合度: 新規フィールドは ProjectDefinition → endpoint フィールド下のみ参照
- [x] 循環依存: なし (新規モジュール import なし)
- [x] インターフェース分離: UserProjectOverview は内部用 (WS response に使用)

**評価: A** — 新規派生フィールド追加のみで既存構造の凝集度を損なわない

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | 設計強度 | A | 0 |
| 2 | 設計思想の一貫性 | A | 0 |
| 3 | モジュール分割度 | A | 0 |

**設計所見**: 4 層防御・常時接続・権限チェックの既存フレームワークを損なわないまま、 Memoria 連携に必要なメタデータフィールドを副次的に追加。 スキーマ拡張の模範例。
