# REVIEW_IMPLEMENTATION — 2026-05-13

評価: **B**

## 良い点

- **close 後 send レース対策**: `server/src/app.ts:38-49` の `WsUserData.closed` フラグを `handleWsClose` 冒頭 (`server/src/ws/handler.ts:194-200`) で同期的に立てる二重防御は uWS の落とし穴を確実に塞いでいる。 `project-handler.ts:167-178`, `composite-auth.ts` も同じパターン。
- **operation_logs の書き込み失敗ハンドリング**: `commands.ts:64-77` の `finally` で挿入し、 失敗時は `console.error("[operation_logs] insert failed (audit trail at risk)")` を出すのは監査要件と整合。
- **upgrade 時の `aborted` 判定**: `app.ts:148-151, 183-186, 230-233` で `res.onAborted` → `aborted` 変数 → 非同期検証後の早期 return という uWS のお作法を全 WS で正しく実装。
- **`projectUserToken` の管理プロジェクト存在 + active チェック**: `auth-handler.ts:307-313` で `key` で managed_projects を引き `isActive` を確認している。 単に user JWT を持つだけでは任意 project 名で token を発行できない点が良い。

## 改善余地

### I-1. `verify` action の制御フローが catch fall-through

- 場所: `server/src/http/auth-handler.ts:205-237`
- `try { verifyProjectToken } catch { /* fall through */ } try { verifyToken } ...` の構造は、 「project token として有効だが managed_projects に居ない」場合に黙って user token 検証に進む。 期待動作だが、 **意図的なフォールスルーである旨をテストで固定** すべき (テスト見当たらず)。

### I-2. `JwtClaims.role` を string 型でしか縛らない

- 場所: `server/src/auth/jwt.ts:14`、 `commands.ts` の各 sub-dispatcher
- `role` が `"admin" | "general"` のような literal union ではなく `string`。 タイポ (`"Admin"` 等) を型システムで検知できない。 `as const` literal union 化 + Drizzle スキーマ側も pgEnum 検討推奨。

### I-3. `userOrgPermissionDispatcher` 系の 4-Layer 4 実装は各 sub に散在

- 場所: `server/src/commands.ts` 後段 (本ファイル冒頭で確認した部分のみ。 下流の sub-dispatcher 詳細未読のため抜粋)
- 設計コメントには「Layer 4 は委譲」とあるが、 集中化された helper (`requireOrgRole(userId, orgId, ["admin","owner"])`) があるか、 重複してコピペされているかでメンテ性が変わる。 重複なら helper 化を推奨。

### I-4. `resolveWsAuth` が token 経由で来た場合に必ず新セッション発行

- 場所: `server/src/ws/auth.ts:19-32`
- `token` パラメータ付きで `/auth` 接続される度に Redis に新規 session 行が出来る。 既存 session に紐付け直す経路 (revive) がなく、 リロード連打で `session:*` が増殖する可能性。 セッション TTL は 7d なので長期影響あり。 mitigations: token + userId で既存 session を検索する。

### I-5. `id-cache/src/cache.ts:135` の cache key 衝突可能性

- 場所: `packages/id-cache/src/cache.ts:135` (`cache.set(user.id, ...)`)
- ローカル検証で別 token (例: scope 違い、 古い refresh 経路など) でも `user.id` が同じならキャッシュにヒットしてしまう。 token 自体を key に使うか、 (userId, token hash) を key にする方が安全。

### I-6. `composite-auth` の `send` が `closed` フラグだけを見て request_id を返さない

- 場所: `server/src/ws/composite-auth.ts:73-82`
- `error` メッセージに request_id が無いため、 クライアント側で error がどの request 由来か追えない。 `project-handler.ts:152-162` は request_id を含むので、 composite-auth 側も合わせるべき。

## まとめ

uWS の落とし穴対策、 監査ログ確保、 upgrade 時の検証統合は丁寧。 ただし session 増殖 (I-4)、 cache key 衝突 (I-5)、 fallthrough の暗黙性 (I-1) は将来トラブルになりうる。 評価 **B**。
