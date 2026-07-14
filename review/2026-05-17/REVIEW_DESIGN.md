# 設計レビュー — Cernere (Web Service)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| レビュー実施日 | 2026-05-17 |

## 1. 設計強度 (Design Robustness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 障害分離 | WebSocket セッション管理 / Redis state / DB access / HTTP 認証が層状に分離。SPOF なし。Redis 障害時は ustate クエリで失敗 → 401 fail-safe |
| A | 冪等性 | `/api/auth/register` は既存 email チェック → 登録で atomicity 確保。refresh token は db.update で idempotent。マイグレーション sql に `IF NOT EXISTS` 統一 |
| A | 入力バリデーション | HTTP ハンドラで `typeof` 検査 + `requireStr()`。password `>= 8 chars`。projectKey / audience の empty チェック |
| A | エラーハンドリング | classifyError() で 401/403/400/500 に正確にマップ |
| A | リトライ・タイムアウト設計 | Redis set/get TTL (SESSION_TTL_SECS=7日)、paseto token 15分 TTL。外部 API は timeout 未設定 (既知制約) |
| A | 状態管理の明確性 | Redis ustate: logged_in/session_expired 遷移図あり。WebSocket ping/pong 30秒、切断時即座に closed フラグ (race condition 対策) |

## 2. 設計思想の一貫性

| 該当箇所 | 逸脱内容 | 推奨修正 |
|----------|---------|---------|
| - | (逸脱なし) | CLAUDE.md §1.2 完全実装 |

**チェック結果:**
- レイヤー依存方向 OK: HTTP → WS upgrade → dispatch → db/redis (正順)
- 命名規則: `handleAuthRoute`, `requireSystemAdmin`, `organizationCmd` など一貫
- 既存パターン再利用: `getSession`, `putSession` を全レイヤーで統一
- ハードコード値なし: 全て定数化

## 3. モジュール分割度 / 機能的凝集度

| モジュール | 凝集度 | 所見 |
|-----------|--------|------|
| auth/paseto.ts | 機能的 | Ed25519 key 管理 → sign → verify を単一責務で集約 |
| auth/jwt.ts | 機能的 | JWT 署名・検証・token pair 生成を一括 |
| http/auth-handler.ts | 機能的 | auth action を switch 式で統一、各関数は単一責務 |
| ws/handler.ts | 機能的 | WebSocket upgrade / message dispatch / close handling 分離 |
| commands.ts | 機能的 | dispatch + execute で 4 層防御ガード |
| db/schema.ts | 機能的 | Drizzle ORM で 21 table スキーマ定義のみ |
| redis.ts | 機能的 | session 管理に限定 |
| packages/id-cache/cache.ts | 機能的 | JWT decode → cache lookup → Id Service fetch → LRU evict |

**循環依存チェック:** なし。DAG 形状 (app → auth/http/ws → db/redis)。
