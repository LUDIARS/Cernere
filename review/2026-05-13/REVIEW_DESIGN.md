# REVIEW_DESIGN — 2026-05-13

評価: **B**

## 全体構造

Cernere の設計は明確で、 README / `CLAUDE.md` / `spec/security_design.md` の 3 ドキュメントが一貫している。

- 公開エンドポイントは `/auth` のみ (REST) という方針が `app.ts:259-286` の `app.post("/api/auth/:action", ...)` に集約されている
- WebSocket は **用途別に 3 系統** に分離:
  - `/auth` … user 接続 (`app.ts:133-165`)
  - `/ws/project` … managed_project 接続 (`app.ts:168-211`)
  - `/auth/composite-ws` … ticket-based device verification (`app.ts:216-256`)
- 4 層防御は `commands.ts:30-80` で集中ガード。 Layer 4 のみ各 sub-dispatcher に委譲する設計は妥当

## per-user / per-project token の設計 (新規)

`server/src/auth/jwt.ts:88-106` で導入された `generateUserProjectToken` / `verifyUserProjectToken` は、

- `sub = userId` を維持 (既存 Hub 側 `authMiddleware` 互換)
- `kind: "user_for_project"` claim で service token と区別
- HS256 共有鍵で署名 → service 側でローカル検証

という設計で、 MEMORY の `service secret per-user / memory-only` 原則と整合する。 設計意図のコメント (`jwt.ts:35-50`) が丁寧で良い。

## 改善余地のある設計

### A. id-cache 系の `userId` claim 想定が Cernere の `sub` と不整合

`packages/id-cache/src/middleware.ts:55` および `cache.ts:108` は `jwt.verify(token, jwtSecret) as { userId: string; role: string }` を期待しているが、 Cernere は **`sub` で署名する**。 同梱パッケージとして提供する以上、 `sub` を読むか、 Cernere 発行時に `userId` を別 claim にコピーするかの **設計選択** が必要 (MEMORY にも未解決として記録済み)。

### B. dev 用 JWT_SECRET のハードコード

`server/src/config.ts:47-55` は production で `JWT_SECRET` 未設定なら fail-fast するが、 dev では `"cernere-dev-secret-change-in-production"` を使う。 同じ文字列が `packages/id-service/src/core/jwt.ts:7` には `"schedula-dev-secret-change-in-production"` として別に定義されている。 dev/prod の boundary が「環境変数 1 本」しかないため、 **dev 環境間で署名された token がうっかり共有される設計リスク** がある (環境別 default を秒単位の random にする等で改善可)。

### C. composite-auth ticket の TTL と再利用ポリシー

`server/src/auth/auth-session.ts:54` で `AUTH_SESSION_TTL = 10 * 60`、 ticket は session として Redis に保存される。 `resolveCompositeTicket` (`composite-auth.ts:86-94`) は `state === "expired"` のみ拒否し、 **同一 ticket での複数 WS 接続** が文面上は許される (コメントには「1 チケット = 1 WS 接続」とあるが、 強制機構がない)。 ticket 1 本で複数 socket が `state` を購読できると、 万一 ticket が漏れた際の影響範囲が広がる。

### D. dispatch の Layer 2-3 ガードと `userId === ""` の関係

`commands.ts:47` で `if (userId && !PUBLIC_COMMANDS.has(method))` と guard しているため、 ゲスト (`userId === ""`) のときは Layer 2-3 を**完全に skip** する。 ゲストモジュールは `guest.ts` 側で個別認可するが、 dispatch の責務がやや曖昧。 ゲスト用に別ディスパッチャ (`guestDispatch`) を分けたほうが境界が明確になる。

## 結論

設計の骨格は良好。 ただし「id-cache の sub/userId 不整合」「dev 用 secret の境界の脆さ」「composite ticket の 1 接続強制」 の 3 点は **設計レベルで意思決定** が必要なので C に届きうる火種。 評価 **B**。
