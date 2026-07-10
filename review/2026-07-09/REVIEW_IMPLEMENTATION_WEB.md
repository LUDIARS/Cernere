# Web 実装評価 (Web Implementation Evaluation)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

---

## 1. データスキーマの妥当性・重複確認 (Data Schema Validation)

| テーブル / モデル | 問題種別 | 説明 | 推奨対応 |
|-----------------|---------|------|---------|
| `project_oauth_tokens.project_key` (`migrations/014_project_oauth_tokens.sql:3`) | 制約不足 (FK 欠落) | `managed_projects.key` への外部キー制約が無く、プロジェクト削除後も孤立レコードが残りうる。開発チーム自身が `spec/plan/commit-plan.md:54` (H13) で認識済み・未着手。 | `REFERENCES managed_projects(key)` を追加するマイグレーションを発行する。 |
| `service_tickets.organization_id` (`migrations/007_service_registry.sql:23`) | 制約不足 (FK 欠落) | 型付けされた UUID カラムだが参照整合性制約が無い。自己認識済み (H14)。 | 同上、FK 制約を追加する。 |
| `operation_logs.user_id` (`migrations/005_operation_logs.sql`) | 制約不足 (ON DELETE 未指定 = RESTRICT) | ユーザー削除をブロックしうる設計だが、実際には `deleteUserAccount()` (`project/service.ts:503-506`) がトランザクション内で `operation_logs` を事前 purge してから `users` を削除しており、**この特定経路では既に機能的に回避済み**であることを直接確認した。ただし他の削除経路 (もしあれば) では FK 制約が問題になりうる。自己認識済み (H15)。 | FK に `ON DELETE SET NULL` + カラムを nullable 化し、メタデータレベルでも整合させる (機能的な回避に依存しない)。 |
| `project_data_<key>` (動的テーブル、`schema-migrator.ts`) | N+1 の可能性 | `listUserProjectsOverview()`/`listAllUserProjectData()` は `managedProjects` をループしながら都度 `getUserProjectData()` (別接続) を呼ぶため、プロジェクト数に比例したクエリが発生する。プロジェクト数が現状少数 (`managed_projects` は全社で数十件規模と推測) であれば実害は小さい。Low、指摘化はしない。 | 将来プロジェクト数が増えた場合はバッチ取得に見直す。 |

### チェック項目

- [x] 正規化が適切に行われているか: `users`/`organizations`/`organization_members` 等は適切に正規化。個人データ (Cernere が正本) と各サービス固有データ (`project_data_<key>`) の分離も RULE.md §5 に整合。
- [x] 同一概念を表す複数のモデル定義が存在しないか: `managed_projects` と `project_definitions` の並存は `spec/plan/commit-plan.md` M9 で「併存解消」の課題として自己認識済み・未着手 (Medium 相当だが自己申告済みのため新規指摘としない、機能的な重複による実害は現状確認されず)。
- [x] フィールドの型が格納データに対して適切か: `bytea` (passkey公開鍵)、`jsonb` (scopes/metadata)、`timestamptz` (全時刻列) など型選定は妥当。
- [ ] NOT NULL・UNIQUE・外部キー等の制約が必要十分に設定されているか: 上表 3 件 (Medium)。
- [x] インデックスがクエリパターンに対して最適化されているか: 主要な検索列 (`idx_users_email`, `idx_refresh_sessions_user_id`, `idx_operation_logs_method` 等) にインデックスあり。`service_tickets.user_id` に専用インデックスが無い点は Low (`ticket_code`/`expires_at` にはインデックスあり)、指摘化しない。
- [x] マイグレーションに破壊的変更 (カラム削除等) が含まれていないか: 26 本全読、`DROP TABLE`/`DROP COLUMN`/`ALTER COLUMN ... TYPE` は 0 件。`ALTER COLUMN ... DROP NOT NULL` (制約緩和、非破壊) のみ確認 (`migrations/002:5`, `migrations/009:2-3`)。
- [x] API のリクエスト/レスポンス定義と DB スキーマの間に矛盾がないか: `project/schema.ts` (Zod) と `db/schema.ts` (Drizzle) の型定義に食い違いは発見せず。
- [x] Enum・定数の定義がコードとスキーマで一致しているか: `columnTypeEnum` (Zod) と `COLUMN_TYPE_MAP` (Drizzle 側 SQL 型対応表) が 1 対 1 対応。
- [x] N+1 クエリを誘発するスキーマ・関連定義になっていないか: 上表参照 (Low、指摘化せず)。

**指摘 (IMPLWEB-001, Medium)**: 上表 3 件 (`project_oauth_tokens.project_key` / `service_tickets.organization_id` / `operation_logs.user_id` の FK 制約欠落)。開発チームの `spec/plan/commit-plan.md` H13-H15 と同一事象。

---

## 2. SRE観点のレビュー (SRE Review)

| 評価 | 観点 | 所見 |
|------|------|------|
| B | 可観測性 (Observability) | 構造化 JSON ログ (`logAuthEvent`/`redactSensitive`) + Vestigium 統合 (`bootstrap.ts`) を確認。トレース ID/リクエスト ID の明示的な付与は未確認 (分散トレーシングは無い模様)。 |
| B | デプロイ安全性 | `docker-compose.yaml` の prod プロファイルはビルド済みイメージ運用でロールバック可能な構成 (イメージタグ切替で戻せる想定)。ロールバック手順書自体は未確認。 |
| B | スケーラビリティ | セッション状態は Redis (`ustate:{userId}`) に外出しされておりステートレス化されているが、WS 接続 (`sessionRegistry`/`project-registry`) はプロセスローカルの in-memory 状態であり、水平スケール時はマルチインスタンス間の relay/presence 同期が未考慮 (`relay-service.ts` のコメントで「プロセス再起動で全クリア、各 SA が自動再登録」と明記済み — 単一インスタンス運用が前提と読み取れる)。複数インスタンス運用の documented な設計は無い。 |
| B | 障害復旧 (Disaster Recovery) | バックアップ・リストア手順のドキュメントは spec/ に未確認 (下記指摘)。 |
| B | 依存関係管理 | PostgreSQL/Redis の接続断はエラーとして表面化する設計 (無言のフォールバックなし)、`RULE_SRE.md` §1.1 に整合。 |

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| Medium | `server/src/app.ts:547-549` | **IMPLWEB-002**。`GET /health` は liveness チェック (プロセス生存確認、固定 JSON を返すのみ) のみで、DB/Redis 接続性を含む readiness チェックが無い。デプロイ時のロールアウト安全性判断 (トラフィック切替のタイミング) に影響しうる。 | `/health/ready` 等を追加し DB/Redis への簡易疎通確認を含める。 |
| Medium | `spec/` 全体 | **IMPLWEB-003**。SLI/SLO の数値目標定義、バックアップ/リストア手順書が確認できない (`grep -ri "SLO\|SLI\|backup\|バックアップ" spec/` で `spec/setup/paseto-keys.md` 等のトラブルシュート表以外に該当なし)。RULE_SRE.md §1.1 が要求する「バックアップ/リストア方針」の文書化が未達。 | `spec/setup/` または新規 `spec/operations.md` に SLO とバックアップ/リストア手順を記載する。 |
| Medium | `server/src/project/schema-migrator.ts` | `common/REVIEW_DESIGN.md` DESIGN-004 (advisory lock 欠如) を参照。デプロイ安全性の観点からも関連するため本行で言及するが二重計上しない。 | 同ドキュメント参照。 |

### チェック項目

- [x] 構造化ログが出力されているか (トレースID, リクエストID の付与): 構造化 JSON ログは適合。トレース/リクエスト ID の明示付与は未確認 (Low、分散トレーシング基盤 Vestigium 側の機能に依存する可能性があり本リポジトリ単体では判定不能)。
- [ ] メトリクス収集 (レイテンシ, エラー率, スループット) が実装されているか: Prometheus/OpenTelemetry 等の依存は `package.json` に確認できず (未確認、Vestigium 側で提供される可能性がありリポジトリ外)。
- [ ] ヘルスチェックエンドポイントが存在するか (liveness / readiness): liveness のみ (上表 IMPLWEB-002)。
- [x] デプロイがロールバック可能か: イメージタグ切替で対応可能な構成 (適合寄り、Low)。
- [x] 設定変更が再デプロイなしで反映可能か: env/Infisical 経由の設定は再デプロイ (コンテナ再起動) が前提 (一般的な構成、指摘化しない)。
- [x] リソース制限 (CPU / メモリ / コネクションプール) が設定されているか: `postgres(config.databaseUrl, { max: 10, idle_timeout: 20 })` (`db/connection.ts:15-18`) でコネクションプール上限を設定。Docker レベルの CPU/メモリ制限は `docker-compose.yaml` に記載なし (Low)。
- [ ] 水平スケーリングに対応した設計か (ステートレス, 分散ロック等): WS 状態がプロセスローカル (上表所見、Medium 相当だが単一インスタンス運用が明示的な設計判断であるため指摘化せず、所見に留める)。
- [ ] バックアップ・リストア手順が確立されているか: 未確認 (上表 IMPLWEB-003)。
- [ ] SLI / SLO が定義されているか: 未確認 (上表 IMPLWEB-003)。
- [ ] インシデント発生時のランブックが存在するか: `spec/setup/*.md` の個別トラブルシュート表はあるが全社的インシデントランブックは未確認。

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | データスキーマ | B | 0 (Medium 1) |
| 2 | SRE | B | 0 (Medium 2) |

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要
