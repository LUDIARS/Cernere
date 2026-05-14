# Cernere レビュー — 2026-05-13

| 観点 | 評価 |
|------|------|
| Design (設計) | B |
| Vulnerability (脆弱性) | C |
| Implementation (実装) | B |
| Missing Features (機能不足) | B |
| Quality (品質) | B |

総合: weighted_score = 78 / 100

## サマリ

Cernere は LUDIARS 認証 + 個人データ単一情報源として、 `/auth` REST + 3 系統の WebSocket (`/auth`、`/ws/project`、`/auth/composite-ws`) を提供する基盤である。 4 層防御 (token → Redis TTL → user_state → resource ownership) が `commands.ts` に実装されており、 監査ログ (`operation_logs`) も全 WS コマンドに付与される良好な設計が確認できる。

今回新規追加された `/api/auth/project-token` (commit `e2ceb91`) は **per-user × per-project の短命 token** を発行する重要な追加で、 service secret の per-user / memory-only 原則 (Cernere #89 / Memoria #143 で合意済み) を実装上満たすための入り口となる。 設計意図は `server/src/auth/jwt.ts:88-106` のコメントで明確化されており評価できる。

一方で、 以下の **高優先度な指摘** が複数発見された。 詳細は `REVIEW_VULNERABILITY.md` 参照:

1. `/api/auth/verify` がトークン値を 401 ではなく `{valid:false}` で返すため、 落ち着いて見ると user token / project token のどちらでもない HMAC で署名された任意トークンが「無効」扱いになるだけで、 **クライアントから brute-force しても rate limit が無い** (`server/src/http/auth-handler.ts:203-238`)。
2. `JwtClaims` は `sub` を使うが、 packages 配下 (`id-cache/src/cache.ts:119`, `id-cache/src/middleware.ts:56`, `id-service/src/core/middleware.ts:38`) は **`payload.userId` を読む**。 Cernere 自身は `sub` で署名するため、 id-cache 経由で Cernere トークンを検証すると `userId === undefined` になる **整合性バグ**。 MEMORY にも明記された "userId vs sub の不整合" が未解決。
3. `JWT_SECRET` の dev フォールバックがハードコードされており (`server/src/config.ts:47-55`)、 **dev で発行された token を本番に持ち込まれた場合の境界が secret 1 本に依存**。
4. `/api/auth/project-token` の rate limit は `60 req/min` per (user, project) (`server/src/http/auth-handler.ts:305`)。 短命 token を memory-only で運用するなら問題ないが、 user/project 単位での **全体上限** が無いため、 user JWT が漏洩した際に大量の per-project token を再発行されうる。

実装品質は概ね良好だが、 `auth-handler.ts:248-252` の `console.log` がトークン値の先頭 8 文字 + 長さを **平文ログ** に書く点 (`code` は短命だがログに残る) と、 `verifyProjectToken` / `verifyUserProjectToken` で catch ブロックが **元エラーの種類を握り潰す** (期限切れ vs 署名不正 vs claim 不正 が同じ 401 文言になりデバッグ困難) 点を直すと運用が楽になる。

## 自動修正可否

すべての指摘は設計判断・テスト追加・運用方針の確認を伴うため、 ソースコードの自動修正は本レビューでは **実施しない** (autofix_count=0)。 個別 issue 化のうえ、 担当者と協議して PR を切るのが望ましい。

## 関連ファイル

- `server/src/auth/jwt.ts:1-153`
- `server/src/http/auth-handler.ts:203-332`
- `server/src/ws/auth.ts:1-36`
- `server/src/ws/project-handler.ts:74-98`
- `server/src/commands.ts:30-80`
- `server/src/config.ts:47-55`
- `packages/id-cache/src/cache.ts:105-112`
- `packages/id-cache/src/middleware.ts:52-65`
