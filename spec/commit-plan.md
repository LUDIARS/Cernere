# コミット計画書 — Issue #49 / #63 / #64 対応

3 つの OPEN issue (#49 / #63 / #64) について、各項目を PR 単位に分解した実装計画。
各 PR は CI 通過 → auto-merge → 次へ、の順次方針。

> **状態凡例**
> - ✅ DONE: マージ済み
> - 🚧 IN PROGRESS: ブランチあり / 実装中
> - ⏸ BLOCKED: 環境問題等で停止
> - ⬜ TODO: 未着手

---

## 完了

| PR | branch | item | 状態 |
|---|---|---|---|
| #72 | `fix/issue-49-ws-authz-4layer` | #49 全 + #63 C5 + #63 H11 | ✅ DONE (`d3ed6ae`) |

PR #72 で対応した内容:
- `commands.dispatch` に Layer 2-3 (Redis セッション + LoggedIn) ガード (= #63 C5)
- `operation_logs` の silent catch を `console.error` に変更 (= #63 H11)
- `resolveProjectWsAuth` に `projectKey × DB` 整合性チェック (= #49 §1)
- `spec/security_design.md` §3.2-3.4 を実装に合わせて更新 (= #49 §3)
- 4 層防御 middleware の集中ガード (= #49 §2 部分対応)

直近で対応済みの C4 (本番 JWT_SECRET 弱既定値) は `113a7b9` の `config.ts isProduction()` で NODE_ENV 評価済み。

---

## Issue #63 Critical (残 8 項目 — Phase 1)

| PR # | branch | item | 規模 | 備考 |
|---|---|---|---|---|
| 2 | `fix/c1-rust-legacy-cleanup` | C1: `src/*.rs` / `Cargo.*` 削除、CLAUDE.md tech stack 更新 | 約 11K 行削除 | 🚧 IN PROGRESS |
| 3 | `fix/c2-c3-oauth-state-hardening` | C2: link state の CSRF 強制、C3: composite_origin を service_registry ホワイトリストで完全一致照合 + state パース簡素化 | 中 | ⬜ |
| 4 | `fix/c6-ping-pong-timeout` | C6: ping 送信後 10s タイマで lastPingAt 検査 → 超過時 ws.end + state=session_expired | 小 | ⬜ |
| 5 | `fix/c7-sql-escape-drizzle` | C7: project/service.ts の生 SQL を sql.identifier + パラメータバインドに置換、死に枝除去 | 中 | ⬜ |
| 6 | `fix/c8-localstorage-to-cookie` | C8: フロントの JWT 保管を httpOnly Cookie + WS sessionId 一本化、localStorage 撤去 | **大** (フロント全面改修) | 設計確認必要 |
| 7 | `fix/c9-csp-ws-origin` | C9: nginx に CSP / X-Frame / HSTS / Referrer-Policy / nosniff を追加、WS upgrade に Origin ホワイトリスト | 中 | ⬜ |

## Issue #63 High (残 16 項目 — Phase 2)

| PR # | branch | item | 規模 |
|---|---|---|---|
| 8 | `fix/h1-first-admin-race` | H1: `users.is_first_admin` カラム + パーシャル UNIQUE で初回 admin 競合解消 | 小 + migration |
| 9 | `fix/h2-ratelimit-lua` | H2: redis.ts の INCR + EXPIRE を Lua EVAL で原子化 | 小 |
| 10 | `fix/h3-oauth-token-encrypt` | H3: users.google_*_token と session.accessToken を AES-GCM で at-rest 暗号化 (KMS/SSM 由来 DEK) | **大** + key 設計 |
| 11 | `fix/h4-h5-h6-oauth-tokens-misc` | H4: GitHub/Google API エラーを Zod で検証、H5: verify を invalid_token 統一、H6: refresh で users 生存確認 | 中 |
| 12 | `fix/h7-h10-cookie-cors` | H7: ars_session を SameSite=Strict、OAuth 用は別 Cookie。H10: CORS Allow-Methods から PUT/DELETE 削除 | 小 |
| 13 | `fix/h8-like-escape` | H8: ILIKE 検索で % _ \ を replace + ESCAPE '\' 句 | 小 |
| 14 | `fix/h9-trusted-devices-unique` | H9: SELECT 条件に revoked 含めて再登録経路を直す + UNIQUE 制約レビュー | 小 |
| 15 | `fix/h12-tool-audit-log` | H12: toolLogin に logAuthEvent (success/failure) 追加 | 小 |
| 16 | `fix/h13-h14-h15-fk-cleanup` | H13: projectOauthTokens.projectKey FK、H14: serviceTickets.organizationId FK、H15: operationLogs.userId onDelete: set null + nullable 化 | migration |
| 17 | `fix/h16-advisory-lock` | H16: schema-migrator.ts の DDL ブロックを pg_advisory_lock で serialize | 小 |
| 18 | `fix/h17-project-data-org-check` | H17: project_data 取得時に所属 org が organization_projects で当該 project を有効化済か検証 | 中 |

## Issue #63 Medium (20 項目 — Phase 3)

| PR # | branch | item |
|---|---|---|
| 19 | `fix/m1-m2-ws-session-1to1` | M1: token に sid claim 入れて 1:1 化、M2: onAborted 後 DB 副作用を冪等化 |
| 20 | `fix/m3-m5-m17-silent-catch` | M3: identity issueChallenge の send 失敗→Redis ロールバック、M5: notifyPresenceChange の catch を log 化、M17: ユーザ単位 challenge 発行 rate limit |
| 21 | `fix/m4-zod-payload-schema` | M4: module_request の payload を module/action ごと Zod 登録 (#64 同項目も解決) |
| 22 | `fix/m6-https-flag` | M6: config.isHttps を専用フラグ CERNERE_HTTPS に分離 |
| 23 | `fix/m7-docker-compose-cleanup` | M7: depends_on / healthcheck / network 整備、apt-get install git を Dockerfile に移動 |
| 24 | `fix/m8-m19-cleanup-jobs` | M8: service_tickets / refresh_sessions の TTL 切れ削除 cron、M19: revoked refresh の DELETE |
| 25 | `fix/m9-managed-projects-merge` | M9: managed_projects と project_definitions の併存解消 |
| 26 | `fix/m10-hardcoded-urls` | M10: imperativus schema / migration 012 のハードコード URL を env / service_registry に寄せる |
| 27 | `fix/m11-m12-package-files` | M11: composite package files から src 除外、M12: peerDependencies 追加 |
| 28 | `fix/m13-drizzle-kit-check-ci` | M13: drizzle-kit check を CI workflow に追加 |
| 29 | `fix/m14-jsonb-bind` | M14: escapeDefault の二重 encode 修正、$1::jsonb バインド |
| 30 | `fix/m15-op-logs-size-limit` | M15: operation_logs.params に pg_column_size CHECK 制約 |
| 31 | `fix/m16-definition-history-uniq` | M16: project_definition_history に (projectKey, version) UNIQUE |
| 32 | `fix/m18-dev-secret-dynamic` | M18: dev でも JWT_SECRET をプロセス起動時に動的生成 (warn 一回) |
| 33 | `fix/m20-vite-api-base-validate` | M20: VITE_API_BASE の同 origin 検証を boot 時に実施 |

## Issue #64 横断項目 (#63 と被らないもの — Phase 4)

| PR # | branch | item |
|---|---|---|
| 34 | `fix/64-ws-token-via-subprotocol` | クエリ JWT を廃止、Sec-WebSocket-Protocol または接続後最初のメッセージで送出。アクセスログ regex マスク |
| 35 | `fix/64-4layer-lua-atomic` | 4 層を Redis Lua スクリプトで原子化 (TOCTOU 解消) |
| 36 | `fix/64-ustate-per-session` | `ustate:{user}` を `ustate:{user}:{session}` に分解、複数デバイス上書き衝突を解消 |
| 37 | `fix/64-step-up-mfa` | 破壊的操作に step-up MFA / TOTP 再提示要求 |
| 38 | `fix/64-jwt-jti-revocation` | JWT に jti claim、Redis で失効リスト管理 (logout で即時無効化) |
| 39 | `fix/64-totp-replay-protection` | TOTP `{user}:{counter}` を Redis に 2 窓分消費記録 |
| 40 | `fix/64-bootstrap-admin-only` | 初期 admin を env から bootstrap、オンライン昇格を禁止 (H1 の発展) |
| 41 | `fix/64-relay-zod-fanout-limit` | relay payload Zod 検証 + size 上限 (16KB) + rate (10msg/s) + broadcast ファンアウト上限 |
| 42 | `fix/64-module-request-strict` | module/action を strict enum、deny_unknown_fields、重複キー拒否、破壊的に nonce |
| 43 | `fix/64-migration-skip-report-ci` | スキップされた migration ステートメントを CI でレポート、レビュー必須化 |
| 44 | `fix/64-reactivation-mfa` | is_active=false → true 復活時に admin MFA を要求 |
| 45 | `fix/64-reconnect-window` | 切断後 30s の再接続窓 + fingerprint 一致で LoggedIn 維持 |
| 46 | `fix/64-audit-log-hash-chain` | operation_logs に直前行の SHA-256 を含めるハッシュチェーン + WORM 同期スタブ |
| 47 | `fix/64-rate-limit-tiers` | IP / user / session / module_action の 4 粒度 rate limit |

---

## サマリ

| 区分 | PR 数 |
|---|---|
| 完了 | 1 (PR #72) |
| Phase 1 (Critical 残) | 6 (PR #2-7) |
| Phase 2 (High 残) | 11 (PR #8-18) |
| Phase 3 (Medium) | 15 (PR #19-33) |
| Phase 4 (#64 横断) | 14 (PR #34-47) |
| **計画 PR 総数** | **46** (#2 - #47) |

| 規模分類 | PR 数 |
|---|---|
| 小 (≤200 行) | 約 22 |
| 中 (200〜600 行) | 約 18 |
| 大 (600 行〜or 全面改修) | 6 (C8, C9, H3, H10/旧概念, M3, 64-relay) |
| migration を伴う | 8 (H1, H13-15, M14, M15, M16, 64-jti, 64-audit-chain) |
| CI workflow 変更 | 2 (M13, 64-migration-report) |

## 要設計判断 (実装前にユーザ確認したい項目)

| 項目 | 確認したいこと |
|---|---|
| H3 (OAuth token 暗号化) | DEK の出所 (KMS / SSM / Vault?)、ローテ運用 |
| C8 (localStorage → Cookie) | 全サービス (Actio 等) のクライアント影響、移行戦略 |
| 64-step-up-mfa | どの操作を破壊的とみなすか、UX (毎回 vs セッション内 1 回) |
| 64-bootstrap-admin-only | 初期 admin の env キー名、複数 admin 投入の許可 |
| 64-audit-log-hash-chain | WORM ストレージ (S3 Object Lock?)、検証ツール仕様 |

## 進行ルール

1. 上から順に branch を切る
2. 実装 → `npx tsc --noEmit` PASS 確認
3. push + `gh pr create` + `gh pr merge --auto --squash --delete-branch`
4. `git checkout main && git pull` で次へ
5. 1 PR が CI red になったら修正コミットし、緑になるまで次に進まない

## 既知の障害

- **git 環境問題 (2026-04-26)**: msysgit 2.24 (SourceTree バンドル) で git rm / git update-index / git commit -a / git status が hang。zombie git プロセス 41+ 残留。新セッションまたは Git for Windows 2.40+ への更新が必要。
