# AUTOFIX — 2026-05-13

本レビューで **ソースコードの自動修正は実施していない** (autofix_count = 0)。

## 自動修正を見送った理由

本レビューは Cernere (LUDIARS 認証 + 個人データ単一情報源) を対象としており、 指摘事項はいずれも設計判断・運用方針・テスト戦略を伴うものであるため、 PR 化にはレビューレビュー者 (Cernere maintainer) の合意が必要。 単独の機械的な置換 (typo / import 並べ替え程度) は今回見つかっていない。

## 個別 issue 化推奨リスト

優先度順に列挙する (修正は別途人手 PR にて実施)。

### High

1. **id-cache の `payload.userId` → `payload.sub ?? payload.userId` 互換化**
   - 対象: `packages/id-cache/src/cache.ts:105-112`, `packages/id-cache/src/middleware.ts:55-65`, `packages/id-service/src/core/middleware.ts:38`
   - 影響範囲: Cernere トークンを使う全サービス。 互換 layer を入れる + テスト追加が必須。

### Medium

2. **`/api/auth/verify` に IP ベースの rate limit を追加**
   - 対象: `server/src/http/auth-handler.ts:203-238`
   - 案: `await checkRateLimit(\`verify:${ctx.ip ?? "unknown"}\`, 60, 60)` を冒頭に追加。

3. **`auth-handler.ts` の `[trace:exchange]` console.log を削除 / devLog 化**
   - 対象: `server/src/http/auth-handler.ts:242-252`
   - 平文 token 断片を prod ログに残さない。

4. **`verifyProjectToken` / `verifyUserProjectToken` の catch で `err.name` を内部ログに残す**
   - 対象: `server/src/auth/jwt.ts:108-130`
   - ユーザー応答は `Invalid or expired ...` のままで OK、 内部 log に `TokenExpiredError` 等を残す。

5. **dev JWT_SECRET をプロセス起動時にランダム生成 (process memory only)**
   - 対象: `server/src/config.ts:47-55`
   - dev 環境間で token が偶発的に通らないよう、 `crypto.randomBytes(32).toString("hex")` をデフォルトに。

### Low

6. **`extractBearerToken` を case-insensitive 化** (`server/src/auth/jwt.ts:148-151`)
7. **`/api/auth/project-token` に user 横断 rate limit を追加** (`server/src/http/auth-handler.ts:305`)
8. **`composite-auth.ts` の `error` 応答に `request_id` を含める** (`server/src/ws/composite-auth.ts:73-82`)
9. **`bash.exe.stackdump` / `grep.exe.stackdump` を `.gitignore` に追加**

## 機能追加 (long-term)

- token revoke API (`jti` blacklist) — REVIEW_MISSING_FEATURES F-1
- trusted device 自己管理 WS コマンド + UI — F-3
- MFA backup codes — F-4
- per-user token に `aud` claim 追加 + service 側で audience 検証 — F-5

## カテゴリ別件数

| カテゴリ | 件数 |
|----------|------|
| typo | 0 |
| security | 0 |
| docs | 0 |
| lint | 0 |
| dead_code | 0 |
| **合計 (autofix_count)** | **0** |
