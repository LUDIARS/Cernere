# 設計レビュー（共通） (Design Review — Common)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

---

## 1. 設計強度 (Design Robustness)

| 評価 | 観点 | 所見 |
|------|------|------|
| B | 障害分離 | Redis/PostgreSQL 接続断は各ハンドラで try/catch し 500 を返す設計 (`app.ts` classifyError)。SPOF はアーキテクチャ上 Cernere 自体が LUDIARS 全体の認証 SPOF だが、これは設計方針 (RULE.md §1「Cernere を単一情報源とする」) であり指摘化しない。 |
| B | 冪等性 | migrations (26 本全読) は全件 `IF NOT EXISTS`/`ON CONFLICT` で冪等。`schema-migrator.ts` の DDL も冪等だが、並行実行時のロックが無い (下記チェック項目参照)。 |
| C | 入力バリデーション | `common/REVIEW_VULNERABILITY.md` §1 (VULN-002: email/password 検証欠如、High) を参照。本行は集約せず当該ドキュメントの重大度をそのまま反映。 |
| A | エラーハンドリング | `AppError` による統一エラー型、`classifyError()` による 4xx/5xx 一元マッピング (`app.ts:149-182`)。空 catch は確認範囲内で発見せず (`rg "catch \{\}" server/src` → 0 件、`catch {}` の空塊は要所で意図コメント付き best-effort のみ)。 |
| B | リトライ・タイムアウト設計 | WS ping/pong (30秒間隔) ・fingerprint 収集失敗時の 3 秒後自動リトライ (フロント) を確認。Infisical fetch (`env-bootstrap.ts`) にはタイムアウト/リトライが無く、起動時に応答が返らない場合ハングしうる (Low、致命度は起動フェーズに限定)。 |
| B | 状態管理の明確性 | Redis `ustate:{userId}` (none/logged_in/session_expired) の遷移が明確に文書化 (CLAUDE.md §1.2 Step 7) され実装と一致。 |

### チェック項目

- [x] 単一障害点 (SPOF) が存在しないか: Cernere 自体が意図された単一情報源 (RULE.md §1/§5) であり対象外。PostgreSQL/Redis は「共有インフラ前提」(RULE_SRE.md §1.1) と明記され、これも対象外。
- [x] 外部サービス・外部リソース障害時の縮退動作が定義されているか: DB/Redis 接続断は 500 応答 (fail loud、fail-safe)。degrade to stub 等の危険な暗黙フォールバックは確認されず。
- [ ] 入力値の境界値・異常値に対する防御が十分か: `common/REVIEW_VULNERABILITY.md` VULN-002 参照 (未達)。
- [x] エラー発生時にシステムが安全な状態に遷移するか (fail-safe): PASETO/OIDC 鍵未設定時は明示的無効化 (fail-closed)、JWT_SECRET 未設定は起動時 throw。
- [x] 非同期処理のタイムアウトとキャンセル機構があるか: `ws-client.ts` (フロント) に 10 秒タイムアウト、WS ping/pong に生存確認あり。
- [ ] 競合状態 (race condition) のリスクが排除されているか: `server/src/project/schema-migrator.ts` の `migrateProjectSchema()` (CREATE TABLE / ADD COLUMN) は `postgres(config.databaseUrl, { max: 1 })` の使い捨て接続で advisory lock を取らない。同一 projectKey への同時 `registerProject`/`updateProjectSchema` 呼び出しが競合した場合、個々の DDL 文自体は `IF NOT EXISTS` で冪等だが、`information_schema.columns` の読み取りとその後の `columnsAdded` 判定の間に TOCTOU の隙がある (実害は「追加されたカラムの報告漏れ」程度で致命的ではない)。開発チーム自身も `spec/plan/commit-plan.md:55` (H16) で「schema-migrator.ts の DDL ブロックを pg_advisory_lock で serialize」と認識済み・未着手。 → **DESIGN-004 (Medium)**

**指摘 (DESIGN-004, Medium)**: `server/src/project/schema-migrator.ts:27-92` — 同一 `projectKey` への並行スキーマ更新に対する advisory lock が無い。推奨: `pg_advisory_lock(hashtext(projectKey))` で DDL ブロックを直列化する。

---

## 2. 設計思想の一貫性 (Design Philosophy Compliance)

| 該当箇所 | 逸脱内容 | 本来の設計思想 | 推奨修正 |
|----------|---------|--------------|---------|
| `frontend/src/lib/device-fingerprint.ts` と `packages/composite/src/ui/device-fingerprint.ts` | ほぼ同一ロジック (OS/browser 判定・fingerprint 収集) が 2 箇所に独立実装されている (フロント側にはローカル固有のコメントが無く、composite 側にのみ「`navigator.platform` は非推奨だが fallback として使う」等の注記がある) | RULE_CODE.md §6「既存のユーティリティ・ヘルパーを無視した再実装がないか」/ 共有ライブラリ (`packages/composite`) は本来この重複を解消する場所 | `frontend` 側を `packages/composite/src/ui/device-fingerprint.ts` の re-export に統一する |
| `server/src/http/auth-handler.ts:63-91` / `server/src/http/composite-handler.ts:155-191` / `server/src/ws/guest.ts:40-79` | ユーザー登録処理 (email/password/name バリデーション、bcrypt hash、role 判定、refreshSession 発行) がほぼ同一のまま 3 箇所に複製されている | RULE_CODE.md §6 DRY 原則 | 共通の `registerUser()` サービス関数に集約し、3 つのエントリポイントはそれを呼ぶだけにする (併せて VULN-002 のバリデーション追加も 1 箇所で済む) |
| `packages/id-service/src/core/middleware.ts`, `packages/id-cache/src/middleware.ts`, `packages/id-cache/src/cache.ts` (id-service とは別系統のレガシー/実験的パッケージ群と推測) | JWT claim 正規化 (`userId ?? sub` フォールバック) が同一コメント付きで 3 箇所に複製 | 同上 (DRY) | 共通ヘルパーへ切り出す |

### チェック項目

- [x] レイヤー間の依存方向が規約通りか: `server/src` 内は http/ws → project/auth → db の一方向依存を確認。`packages/*` から `server/src` への逆依存は検索で 0 件。
- [ ] 命名規則がプロジェクト全体で統一されているか: `packages/id-cache`/`packages/service-adapter` の JSDoc 例が `@cernere/*` を import 例として示すが、実際の公開パッケージ名は `@ludiars/cernere-*` であり (`package.json` name フィールドと不一致)、そのままコピペすると解決しない。Medium。
- [ ] 共通パターンが一貫して適用されているか: 上表 (バリデーション・fingerprint の重複)。
- [ ] 既存のユーティリティ・ヘルパーを無視した再実装がないか: 上表。
- [x] 責務の配置がアーキテクチャの意図と合致しているか: `project/relay-service.ts` のコメント「Cernere は認証局に徹し、データ経路には入らない」が実装 (endpoint registry + challenge のみ、実データ中継なし) と一致。
- [x] 設定値のハードコーディングがないか: `server/src/config.ts` は全値を `env()`/`envBool()` 経由で取得。ただし `docker-compose.override.yaml` の秘密鍵ハードコードは `common/REVIEW_VULNERABILITY.md` VULN-001 で扱う (本行では二重計上しない)。

**指摘 (DESIGN-001, Medium)**: fingerprint 実装の重複 (上表)。
**指摘 (DESIGN-002, Medium)**: 登録処理バリデーションロジックの 3 重複 (上表)。
**指摘 (DESIGN-005, Medium)**: `packages/service-adapter/src/index.ts:9`, `packages/service-adapter/src/middleware.ts:35` の JSDoc import 例が誤ったパッケージ名 (`@cernere/service-adapter`) を示す。実際は `@ludiars/cernere-service-adapter`。

---

## 3. モジュール分割度 / 機能的凝集度 (Cohesion & Modularity)

| モジュール / クラス | 凝集度評価 | 所見 |
|-------------------|-----------|------|
| `server/src/project/service.ts` (1077 行) | 機能的 (単一責任: managed project の CRUD + user data + OAuth token storage) | 行数は大きいが「project 管理」という単一責任の中の複数サブ機能であり、RULE_CODE §2 の「1000 行を超えてもやむなし」に該当しうる。ただし OAuth token storage (§ OAuth Token Storage セクション) は責務としてやや独立性が高く、`project/oauth-token-storage.ts` への分離余地がある (Low)。 |
| `packages/id-service/src/core/routes.ts` (608 行) | 手続き的 (register/login/refresh/logout/Google OAuth/`/me`/users 一覧/role 変更/password 変更/plugin を単一 Hono サブアプリに直列で実装) | 複数の無関係に近い責務 (認証・OAuth 交換・RBAC・ユーザー管理) が 1 ファイルに同居しており SRP 違反寄り。`server/src` 側の同等機能 (`http/auth-handler.ts` 等) がモジュールごとに分割されているのと対照的。**DESIGN-003 (Medium)**。 |
| `server/src/commands.ts` (611 行) | 機能的 (WS `module_request` の集中ディスパッチ) | switch 文で module ごとにサブ関数へ委譲する構造が一貫しており、各サブ関数 (`organizationCmd`/`memberCmd` 等) は単一責任。適合。 |
| `server/src/ws/*` (9 ファイル) | 機能的 | `auth.ts`/`handler.ts`/`guest.ts`/`composite-auth.ts`/`project-handler.ts` が用途別に明確分離。循環依存は `grep -rn "from \"\.\./ws"` で server/src 内クロス参照を確認したが循環パターンなし。 |

### チェック項目

- [x] 1つのクラス・モジュールが複数の無関係な責務を持っていないか: `packages/id-service/src/core/routes.ts` が該当 (上表)。
- [x] God Object / God Class が存在しないか: 上記 1 件を除き大きな逸脱は確認されず。
- [x] 結合度が不必要に高くないか: `project/service.ts` は `db`/`config`/`schema` に依存するのみで WS/HTTP 層から独立。
- [x] 循環依存が発生していないか: `server/src` 内は確認範囲で 0 件。`packages/*` 間は `composite → service-adapter` の一方向のみ (`id-cache`/`id-service`/`env-cli` は leaf)。
- [x] インターフェースが適切に分離されているか: `project/data-sharing.ts` が「純粋な権限解決関数」と「DB I/O」を意図的に分離済み (コメントで明記)。
- [x] パッケージ・ディレクトリ構成がドメインの構造を反映しているか: `server/src/{auth,http,ws,project,oidc,db,lib,logging}` はドメインに沿った構成。

**指摘 (DESIGN-003, Medium)**: `packages/id-service/src/core/routes.ts:1-608` — 単一ファイルに認証/OAuth/RBAC/plugin 管理が同居 (上表)。推奨: ルートをドメイン別ファイル (auth/oauth/users/plugins) に分割する。

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | 設計強度 | B | 0 (Medium 1) |
| 2 | 設計思想の一貫性 | B | 0 (Medium 3) |
| 3 | モジュール分割度 | B | 0 (Medium 1) |

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要
