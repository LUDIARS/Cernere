# Cernere テスト設計書

Cernere（LUDIARS 認証プラットフォーム）のテスト設計。**種別ごと**に「目的 /
対象 / 実行方法 / CI での扱い / 現状 / やること」を定義する。

上位ルールは AIFormat [`RULE_TEST.md`](https://github.com/LUDIARS/AIFormat/blob/main/RULE_TEST.md)
（§1 CI 必須 / §2 アーキ別テスト設計 / §3 テスト充実度を品質基準とする）。
Cernere は **Web サービス（認証）** に分類されるため、§2 の「認可境界・破壊的
操作のガード・マイグレーション冪等性」を重点に据える。

> 認証系の鉄則: **異常系（偽造・改竄・期限切れ・取り違え・権限外）を正常系と
> 同じ密度でテストする**。「正しいトークンが通る」より「不正なトークンが
> 確実に弾かれる」ことを担保するのが価値の中心。

---

## 種別一覧（サマリ）

| 種別 | 目的 | 依存 | CI 実行 | 現状 |
|------|------|------|---------|------|
| 1. ビルドチェック | コンパイル/型が壊れていない | なし | ✅ `compile-check.yml` | 実施中 |
| 2. ユニット（純ロジック） | 暗号・検証・バリデーションの正誤 | なし | ✅ server `pnpm test` | 一部（token 層） |
| 3. smoke（起動確認） | 起動・health・認可境界が生きている | PG/Redis | ❌ 未 | 未着手 |
| 4. 統合（エンドポイント） | register/login/refresh/token の経路 | PG/Redis | ❌ 未 | 未着手 |
| 5. WS / セッション | 常時接続・状態遷移・リレー権限 | PG/Redis(+WS) | ❌ 未 | 未着手 |
| 6. マイグレーション | 冪等・再適用安全 | PG | ❌ 未 | 未着手 |
| 7. パッケージ契約 | id-cache / service-adapter の公開 API | なし | △ 一部 | service-adapter のみ |

凡例: ✅ = CI で回している / △ = テストはあるが CI 未配線 / ❌ = 未

---

## 1. ビルドチェック（build / typecheck）

- **目的**: TypeScript が型エラー無くコンパイルできること。「ローカルでは通る」を排除。
- **対象**: `server/`、`frontend/`、`packages/*`。
- **実行**: 各ディレクトリで `npx tsc --noEmit`（frontend は `tsc -b --noEmit`）。
- **CI**: `.github/workflows/compile-check.yml`（ubuntu / Node 24 / pnpm 10）で
  server / frontend / packages を別ジョブで typecheck。
- **現状**: 実施中。
- **やること**:
  - [ ] `packages/id-service` / `composite` / `service-adapter` も typecheck ジョブに追加（現状 env-cli のみ）。
  - [ ] `server build`（`tsc` emit）まで含めるか検討（`--noEmit` で十分かは要判断）。

## 2. ユニットテスト（純ロジック・DB/Redis 不要）

- **目的**: 暗号・トークン・入力バリデーション等、外部 I/O を持たないコア
  ロジックの正誤を高速・決定的に固定する。
- **対象と観点**:
  - **トークン層**（実施済）
    - `server/src/auth/jwt.ts` — access / project / user_for_project の発行・検証、
      別 secret 署名（偽造）拒否、改竄拒否、期限切れ拒否、**トークン種別の
      取り違え拒否**、`extractBearerToken`。
    - `server/src/auth/paseto.ts` — Ed25519 sign/verify、**audience 不一致
      （confused deputy）拒否**、`expectedAudience` 必須、改竄・期限切れ拒否、
      鍵ロード / `getPublicKeys`。
  - **入力バリデーション**（未）— 各 module request の Zod スキーマ
    （境界値・必須欠落・型不正・enum 外）。
  - **純ヘルパ**（未）— `error.ts`（AppError のコード/曖昧化）、token claim 整形、
    rate-limit のキー生成ロジック（Redis 呼び出しは差し替え）。
- **実行**: `cd server && pnpm test`（vitest）。テスト用 `JWT_SECRET` は
  `server/vitest.config.ts` の `test.env` で固定。PASETO 鍵はテスト内で
  `generateKeyPairSync("ed25519")` し env 注入してから動的 import する。
- **CI**: server ジョブの `Tests` ステップで実行（実施済）。
- **現状**: token 層 22 本。
- **やること**:
  - [ ] Zod 入力スキーマの境界テスト（register の password 長、project key 形式 等）。
  - [ ] 鍵ローテーション（`CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS`）で旧鍵 token が
        移行ウィンドウ中に検証できることのテスト。
  - [ ] `alg confusion` 系（HS256 期待箇所に none / RS256 を持ち込む）拒否。

## 3. smoke テスト（起動確認）

- **目的**: ビルド成果物が **実際に起動し**、health が返り、認可境界が生きて
  いることを最小コストで確認する（「動くデプロイ可能物か」のゲート）。
- **対象 / チェック**:
  - サーバが listen する（uWebSockets.js が bind）。
  - health / readiness が応答する。
  - **未認証で破壊的操作・保護エンドポイントが拒否される**（401/403）。
  - `/.well-known/cernere-public-key`（PASETO 有効時）が鍵を返す。
- **依存**: PostgreSQL 17 + Redis 7（CI では `services:` コンテナで起動）。
- **実行（想定）**: マイグレーション適用 → `node dist/bootstrap.js` 起動 →
  health を curl → 未認証リクエストで 401 を確認 → プロセス停止。
- **CI**: 未配線（PG/Redis services 付きの別ジョブが必要）。
- **やること**:
  - [ ] `compile-check.yml` に `smoke` ジョブ（`services: postgres / redis`）を追加。
  - [ ] テスト用の最小 env（`DATABASE_URL` / `REDIS_URL` / `JWT_SECRET` / 必要なら
        PASETO 鍵）を CI で注入。OAuth secret は空でも起動できることを保証する。
  - [ ] 起動失敗（DB 未到達・必須 env 欠落）が **fail-fast** することも確認。

## 4. 統合テスト（認証エンドポイント）

- **目的**: register / login / refresh / logout / verify / project-token の経路を
  実 DB・実 Redis で通し、認証フローの整合と防御層を担保する。
- **対象と観点**（`server/src/http/auth-handler.ts` ほか）:
  - **register**: password 最小長、重複ユーザ、bcrypt で**ハッシュ保存**される。
  - **login**: 正パスワードで token 発行、誤パスワードで 401、存在しないユーザで 401、
    **MFA 有効ユーザは `mfaRequired` でゲート**。
  - **refresh**: 有効な refresh で rotation、期限切れ/失効で 401、ユーザ削除後は 401。
  - **verify**: project / user トークンの種別判定が正しい。
  - **project-token（per-user × per-project）**: 不在/無効プロジェクトを拒否、
    DB のロールと token のロールが一致（**ロール詐称の昇格を阻止**）。
  - **破壊的操作の 4 層防御**（[`../../CLAUDE.md`] §1.2 Step6）: トークン検証 →
    Redis TTL → ユーザ状態 → リソース権限、の各層で落ちることを確認。
  - **レート制限**: register/login/verify の閾値超過で 429。
- **依存**: PG + Redis。テストは独立 schema or トランザクションロールバックで分離。
- **CI**: 未配線（smoke と同じ services ジョブに相乗り可）。
- **やること**:
  - [ ] テスト用 DB セットアップ（マイグレーション適用 + 各テストの分離戦略を決める）。
  - [ ] Redis はテスト用 DB index or ephemeral コンテナ。
  - [ ] 上記観点を負の経路中心に網羅。

## 5. WS / セッションテスト

- **目的**: 常時接続セッションの確立・状態遷移・リレー権限という Cernere 固有の
  防御モデルを検証する。
- **対象と観点**（`server/src/ws/auth.ts` / `server/src/redis.ts`）:
  - JWT or session_id での接続確立（`resolveWsAuth`）。無効/期限切れで拒否。
  - 状態遷移 `None → LoggedIn → SessionExpired → LoggedIn`（再認証）。
  - セッション TTL（7 日）失効後の操作拒否。
  - **クロスユーザーリレーの遮断**（同一ユーザーのセッション間のみ許可）。
  - Ping/Pong タイムアウトで `SessionExpired` に落ちる。
- **依存**: Redis（+ WS クライアント）。
- **CI**: 未配線。
- **やること**:
  - [ ] WS テストクライアントで接続→relay→切断の通しを書く
        （`packages/service-adapter` の `fake-cernere` パターンを参考に）。
  - [ ] TTL/タイムアウトは時間注入できる形にして決定的に検証する。

## 6. マイグレーションテスト

- **目的**: マイグレーションが冪等で、既存 DB への再適用が安全（[`../../CLAUDE.md`] §2 の
  スキップ対象エラーコードで握りつぶされる）ことを確認する。
- **対象**: `migrations/*.sql`。
- **観点**: クリーン DB へ全適用 → **もう一度全適用しても成功**する（冪等）。
  `DROP TABLE/COLUMN` や番号重複が無い（静的チェックでも可）。
- **CI**: 未配線（PG services ジョブで実施）。
- **やること**:
  - [ ] CI で「適用 → 再適用」を 2 回回して冪等を確認するステップ。
  - [ ] 禁止 SQL（DROP TABLE/COLUMN / ALTER TYPE / 番号重複）の lint。

## 7. パッケージ契約テスト

- **目的**: 外部に配る `@ludiars/cernere-*` パッケージの公開 API 挙動を固定する。
- **対象**:
  - `packages/service-adapter` — peer relay プロトコル（**実施済**:
    `tests/peer-adapter.test.ts`、7 step handshake / 権限外コマンド拒否 / 未知 peer 拒否）。
  - `packages/id-cache` — token 検証キャッシュの公開 API（未）。
  - `packages/id-service` / `composite` — 公開シグネチャの契約（未）。
- **CI**: service-adapter のテストは存在するが **CI 未配線**。
- **やること**:
  - [ ] service-adapter テストを CI ジョブに追加（`packages/service-adapter` で `pnpm test`）。
  - [ ] id-cache の検証ロジック（consumer が Cernere と同じ結果を得る contract）。

---

## CI 配線の方針（まとめ）

現状 `compile-check.yml` は **typecheck + server ユニット**のみ。段階的に:

1. **(済)** server ユニット（token 層）を server ジョブで実行。
2. **次**: PG/Redis `services:` 付きの `integration` ジョブを 1 つ追加し、
   その中で **smoke → マイグレーション冪等 → エンドポイント統合 → WS** を順に回す
   （services 起動コストを 1 ジョブで償却）。
3. service-adapter / その他 packages のテストをそれぞれ実行ステップに足す。

> カバレッジ数値は課さない（RULE_TEST §2）。「何を充実とみなすか」は本書の
> 各種別の観点で判断し、薄い箇所はレビュー（REVIEW_QUALITY §1）で指摘する。
