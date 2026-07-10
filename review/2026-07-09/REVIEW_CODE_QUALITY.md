# コード品質レビュー（共通） (Code Quality Review — Common)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

---

## 1. コード品質 (Code Quality)

| 該当箇所 | 問題分類 | 説明 | 推奨修正 |
|----------|---------|------|---------|
| `packages/env-cli`, `packages/id-cache`, `packages/id-service`, `packages/service-adapter` の `src/` 全体 | ログ出力 (RULE_CODE §15 違反) | `console.log`/`console.error`/`console.warn` が計 165 箇所 (サブエージェント調査、grep 再確認済み) で使われ、共有ロガー経由でない。`server/src` 側は `bootstrap.ts:15-19` で `installVestigium({ captureConsole: true, ... })` により console 出力が Vestigium 経由で捕捉される設計のため RULE_CODE §15 違反ではない (server 側は対象外と判断)。一方 `packages/*` は Node ライブラリとして他サービスに import される想定であり、呼び出し元の captureConsole 設定に依存せず出力レベル/抑制の手段がない。 | `packages/*` に注入可能なロガーインターフェース (既定は no-op または console) を用意し、呼び出し側で差し替え可能にする。 |
| `packages/service-adapter/src/index.ts:9`, `packages/service-adapter/src/middleware.ts:35` | ドキュメント誤り | JSDoc の import 例が `@cernere/service-adapter` を示すが実パッケージ名は `@ludiars/cernere-service-adapter` (`package.json:2`)。コピペしても解決しない。 | JSDoc例を実パッケージ名に修正する。 |
| `server/src/project/service.ts:563-565` | 不適切な API 利用パターン (一貫性欠如) | `sql.raw` + 手動文字列結合。詳細は `common/REVIEW_VULNERABILITY.md` VULN-003 (脆弱性として計上済み、本行は二重計上しない)。 | 同ドキュメント参照。 |
| `server/src/http/auth-handler.ts` / `composite-handler.ts` / `ws/guest.ts` | DRY 違反 | 登録処理の重複。詳細は `common/REVIEW_DESIGN.md` DESIGN-002 (設計一貫性として計上済み、本行は二重計上しない)。 | 同ドキュメント参照。 |

### チェック項目

- [x] マジックナンバー・マジックストリングが使用されていないか: TTL 等の数値は概ね名前付き定数化 (`PROJECT_TOKEN_TTL_SEC`, `CHALLENGE_TTL_SEC`, `AUTH_CODE_TTL` 等)。フロント側に若干の直書き (`ws-client.ts:59` の 10000ms タイムアウト等) があるが影響は軽微 (Low、指摘化はしない)。
- [x] ファイルパス・URL・ポート番号・ホスト名などの環境依存値がソースに直書きされていないか: `config.ts` 経由で env 化済み。`docker-compose.override.yaml` の秘密鍵直書きは脆弱性軸 (VULN-001) で計上済み。
- [x] 過度にネストした条件分岐がないか: 確認した主要ファイルは早期リターンパターンが徹底されている (例: `auth-handler.ts` 各関数)。
- [x] 未使用のコード・デッドコードが残存していないか: `grep -rn "// TODO\|// FIXME"` (packages) → 0 件。server 側は `spec/plan/` の追跡リストに紐づく形で TODO 相当の項目が管理されている。
- [ ] コピー&ペーストによる重複コードがないか: `common/REVIEW_DESIGN.md` DESIGN-001/DESIGN-002 参照 (二重計上回避のため本表では指摘化せず、チェックのみ未達とする)。
- [x] 変数・関数のスコープが必要以上に広くないか: モジュールスコープの状態 (`endpoints`/`challenges` in `relay-service.ts`, `pingTimers` in 各 ws handler) は用途上妥当 (プロセスローカルの意図的共有状態としてコメントで明示)。
- [x] 例外の握りつぶし (空の catch ブロック) がないか: 意図的な best-effort catch は理由コメント付き (例: `ws/composite-auth.ts` の `ensureProjectRowFromSession` catch)。
- [x] 不適切な型変換・暗黙的型変換がないか: `as` によるキャストは局所化されており濫用は確認されず。
- [x] ログ出力が適切なレベルで記録されているか: `logAuthEvent()` は `.failed`/`.rejected` サフィックスで自動的に warn レベルに切替 (`logging/auth-logger.ts:85`)。
- [x] 命名が役割を正しく表しているか: 概ね適合。
- [x] 関数・メソッドが過度に長大化していないか: `packages/id-service/src/core/routes.ts` は `common/REVIEW_DESIGN.md` DESIGN-003 で計上済み (二重計上回避)。
- [ ] クラス / モジュール / 関数が単一責任を守っているか: 同上 (DESIGN-003 参照)。
- [x] 1 ファイル 1 責務になっているか: 概ね適合 (server/src)。
- [x] レイヤー依存方向が一方向か: `common/REVIEW_DESIGN.md` §3 で確認済み。
- [x] 例外の握りつぶしに理由コメントがあるか: 適合。
- [x] 外部入力をスキーマ検証し、必須前提を入口で検証して fail-fast しているか: `project/schema.ts` は Zod 徹底。一方 HTTP/WS の生ボディ (`auth-handler.ts` 等) は手動 `as string` キャストで Zod 未使用 — `common/REVIEW_VULNERABILITY.md` VULN-002 で計上済み (本行は二重計上しない)。
- [x] 確保した資源が全経路で解放されているか: WS ping timer は `close` ハンドラで確実に `clearInterval` (全 ws ハンドラで確認)。`postgres(...)` の使い捨て接続は `finally` で必ず `sql.end()` (`schema-migrator.ts`, `project/service.ts` 全箇所で確認)。
- [x] floating promise が無いか: `bootstrap.ts:29` の `void bootstrap()` は意図的な fire-and-forget (トップレベル)。`notifyPresenceChange(...).catch(() => {})` 等、catch 明示あり。
- [x] プロセス境界/パイプ/ネットワークの I/O でエンコーディングが明示されているか: `Buffer.from(message).toString()` 等 UTF-8 前提が一貫。
- [x] 子プロセス起動が安全か: 対象外 (子プロセス起動箇所なし、`env-bootstrap.ts` は `fetch` のみ)。
- [ ] secret / 個人データをソース・ログ・例外に出していないか: `common/REVIEW_VULNERABILITY.md` VULN-001 (ソース直書き)、`web/REVIEW_VULNERABILITY_WEB.md` VULNWEB-004 (フロントログ露出) で計上済み。
- [ ] ログが共有ロガー経由か: 上表 (packages/* が Vestigium 未経由、Medium)。
- [x] 時刻が UTC/ISO8601 か: `new Date().toISOString()` を一貫使用。PASETO claims も ISO8601 (paseto v3 規約に合わせた明示的変換、`paseto.ts:207-208` コメントで理由明記)。
- [x] ソース・コメントが UTF-8 か: 確認した全ファイルで日本語コメントが正しく表示 (文字化けなし)。
- [x] 新規依存が最小限か: `server/package.json:25` が `github:uNetworking/uWebSockets.js#v20.63.0` を registry 外から取得する点は Low (再現性の観点、`common/REVIEW_VULNERABILITY.md` §2 で言及済み)。
- [x] non-null 断言の濫用が無いか: `sessionRegistry.ts:24` の `this.userSessions.get(userId)!` は直前で `has()`/`set()` 済みのため安全。濫用パターンは未発見。
- [x] TODO/FIXME が Issue 化されているか: `spec/plan/commit-plan.md` に C1-C9/H1-H17/M1-M20 として体系的に Issue 化・優先度付けされている (好例)。

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | コード品質 | B | 0 (Medium 2) |

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要
