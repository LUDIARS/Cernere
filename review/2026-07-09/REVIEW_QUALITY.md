# 品質保証レビュー（共通） (Quality Assurance Review — Common)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

---

## 1. テスト戦略・カバレッジ (Test Strategy & Coverage)

| 評価 | 観点 | 所見 |
|------|------|------|
| C | unit テストの網羅性 | `server/tests/` は 14 ファイル。`auth/`(jwt/paseto/oidc-keys) と `project/`(data-sharing/identifier/oauth-token-crypto/relay-optout) 等トークン層は充実 (前回レビュー時点から継続して強み)。一方 `server/src` の 49 ファイル中、`http/auth-handler.ts`・`ws/auth.ts`・`ws/handler.ts`・`ws/guest.ts`・`commands.ts` (WS 中央ディスパッチャ)・`db/*` (3 ファイル) は直接テストが 0 件。認証・認可の中核 (login/register/refresh/4層防御 dispatch) が最も薄い。**QUALITY-001 (High)**。 |
| D (未着手) | integration テストの網羅性 | `spec/test/test-design.md` (17-29 行) で 7 種別のテスト計画が定義されているが、smoke/integration/WS/migration の 4/7 種別が「❌ 未着手」と自己申告済み (ドキュメントとの整合は取れている)。RULE_TEST.md が Web サービスに要求する「認証・認可境界 (未認証で破壊的操作が通らないこと) の統合テスト」が存在しない。 |
| 対象外 (理由) | E2E テストの存在 | フロントエンドの主要フロー (login → dashboard) を通す E2E は無いが、`spec/test/test-design.md` が smoke テストとして計画済み・優先度を自覚しており「未実装＝指摘」ではあるが E2E 単体のチェック項目としては integration テストの項に包含して評価する。 |
| C | エッジケース・境界値テスト | token 層 (jwt/paseto) は偽造・改竄・期限切れ・kid ローテーションを網羅 (`server/tests/auth/`)。一方 auth-handler.ts のレート制限・reuse 検出 (refresh token rotation) 等の異常系はテストされていない。 |
| B | CI でのテスト自動実行 | `compile-check.yml` の `server-typecheck` ジョブで `pnpm test` (vitest) を実行、CI 必須。ただし `packages/id-service`・`packages/id-cache` は CI 対象外 (`common/REVIEW_VULNERABILITY.md` CICD-001 参照、二重計上せず)。 |

### チェック項目

- [ ] コアロジックに対する unit テストが存在するか: 上表 (auth-handler/ws/commands.ts が薄い)
- [ ] 外部 I/O (DB, ファイル, ネットワーク) を含む integration テストがあるか: 未着手 (自己申告済み、上表)
- [ ] 主要ユーザーフロー を通す E2E テスト or smoke テストがあるか: 未着手
- [x] 並行性・タイミング依存のロジックに timing-safe なテストがあるか: PKCE 検証の `timingSafeEqual` 自体はコード上確認したが専用のタイミングテストは無し (Low、影響軽微につき指摘化せず)
- [ ] 失敗系・例外系のテストが網羅されているか: token 層は充実、HTTP/WS 層は薄い
- [x] CI で全テストが毎コミット green を求められているか: `server-typecheck` ジョブが必須 (branch protection の実際の設定はリポジトリ側 GitHub 設定であり本リポジトリのファイルからは確認不能、**未確認 (GitHub リポジトリ設定は本レビューのファイルベース調査範囲外)**)
- [ ] flaky test の検出・隔離プロセスがあるか: 確認できるドキュメント無し (未確認)
- [ ] カバレッジ計測ツールが組み込まれていて、目標値が定義されているか: `vitest.config.ts` (server/service-adapter) にカバレッジ設定は確認できず、目標値の記載も spec/ に無し
- [x] モック・スタブが現実の挙動からドリフトしていないか: `packages/service-adapter/tests/peer-adapter.test.ts` は `fake-cernere.ts` で実際に HTTP+WS サーバを立てた統合的テストであり、自作自演の空アサーションではないことを確認 (好例)

**指摘 (QUALITY-001, High)**: `server/src/http/auth-handler.ts` / `server/src/ws/auth.ts` / `server/src/ws/handler.ts` / `server/src/ws/guest.ts` / `server/src/commands.ts` — ログイン/登録/WS 認証・4 層防御ディスパッチという最重要経路に対応する unit/integration テストが 0 件 (`server/tests/` 配下に該当ファイルへの直接テストなし)。RULE_TEST.md が Web サービスに必須とする「認証・認可境界のテスト」の欠落。推奨: `server/tests/http/auth-handler.test.ts` 等を追加し、login/register/refresh の正常系・reuse 検出・rate limit・4 層防御の各層拒否を最低 1 本ずつ通す。

---

## 2. ライセンス遵守・OSS 帰属表示 (License Compliance)

| 該当依存 | ライセンス | 配布形態 | 互換性評価 | 帰属表示状態 |
|---------|----------|---------|-----------|-------------|
| 全依存 (`hono`/`jsonwebtoken`/`bcryptjs`/`drizzle-orm`/`ioredis`/`paseto`/`zod`/`postgres`/`react` 等、`package.json` 記載分) | MIT / Apache-2.0 / BSD (公開メタデータベース、サブエージェント確認) | dynamic (npm 依存) | OK | 未対応 (NOTICE 無し、下記) |
| `uWebSockets.js` (`server/package.json:25`) | Apache-2.0 (registry 外、GitHub tag 参照 `github:uNetworking/uWebSockets.js#v20.63.0`) | dynamic | OK (ライセンス種別上は問題ないが供給経路が registry 外) | 未対応 |

### チェック項目

- [x] プロジェクトのライセンスが明記されているか: `LICENSE` (MIT, リポジトリルート) + `README.md` に記載。
- [x] 依存パッケージのライセンスが許諾範囲を超えていないか: `package.json` の依存一覧 (フルの transitive lockfile 監査は未実施、下記「未確認」参照) で GPL/AGPL 系は確認されず。
- [ ] バンドル配布する OSS について NOTICE / THIRD_PARTY_LICENSES で帰属表示しているか: `find . -iname "NOTICE*" -o -iname "THIRD_PARTY*"` → 0 件。MIT 単体プロジェクトでは必須ではないが、4 パッケージを公開npm配布している以上、他社依存の帰属表示は望ましい。Low。
- [ ] 商用配布前提なら CLA / DCO の運用が定まっているか: 対象外 (内部 org 向け配布、外部 CLA 運用の記載なし)
- [x] プロプライエタリ依存が利用規約を満たしているか: プロプライエタリ依存なし (すべて OSS)
- [ ] 配布バイナリに copyleft 由来のコード混入が無いか (機械チェック): `cargo-deny`/`license-checker` 等の CI 組み込みは確認できず。**未確認 (フル lockfile 走査は本レビューでは未実施)**
- [x] OSS のフォントやアイコン・アセットの再配布条件を満たしているか: `frontend/public/` のアイコン類は自作/汎用アイコンで再配布条件の懸念なし (目視確認)
- [x] AI 生成コードの取り込みについてプロジェクト方針が明文化されているか: `spec/plan/auth-hardening-followups-2026-07.md` が AI 実行者向けの厳密な指示書フォーマットを採用しており方針は実質明文化されている (`common/REVIEW_AI.md` §2 で評価)

**指摘 (LICENSE-001, Low)**: NOTICE / THIRD_PARTY_LICENSES が無い (上表)。推奨: `license-checker` 等を CI に追加し、公開 4 パッケージの NOTICE を自動生成する。

---

## 3. ドキュメント完備性 (Documentation Completeness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | README の網羅性 | `README.md` (291 行) にセットアップ・セキュリティ思想・技術スタック・起動方法 (4 モード)・API・WebSocket・ライセンスの各節を確認。 |
| B | DESIGN / アーキテクチャ図 | `spec/interface/security_design.md` 等でテキストベースの設計記述は充実するが、図 (mermaid 等) は README/docs 双方で確認できず (Low)。 |
| B | API / インターフェースリファレンス | `docs/service_interface.md`・`docs/auth_packages.md`・`spec/interface/*.md` で API 文書化。`site/api.html` として静的サイトも生成されている (`site/` ディレクトリ確認)。 |
| 未確認 | inline コメントの粒度 | 主要ファイルは「なぜ」を書く日本語コメントが徹底 (RULE_CODE §17 準拠の好例)。全ファイルの網羅確認はしていないため未確認とする。 |
| B | 開発者向け CONTRIBUTING / ランブック | `CONTRIBUTING.md` は `find . -iname "CONTRIBUTING*"` で 0 件 (Low)。障害時ランブックも spec/ 未確認 (`web/REVIEW_IMPLEMENTATION_WEB.md` IMPLWEB-003 で SRE 観点として計上、本行では二重計上しない)。 |
| B | spec/ ドキュメント充実度 | 下記チェック項目参照。 |

### チェック項目

- [x] README にプロジェクト概要・前提・最短起動手順があるか: 適合
- [ ] DESIGN.md / ADR が重要決定について残されているか: テキストベースでは充実するが図が無い (Low)
- [x] API のリファレンスが整備されているか: 適合 (`docs/`, `spec/interface/`)
- [x] 公開関数・公開 trait に doc コメントが付いているか: 確認したファイルは概ね適合
- [ ] CHANGELOG / リリースノートが運用されているか: `find . -iname "CHANGELOG*"` → 0 件。Low。
- [ ] 障害発生時のランブック / トラブルシューティングがあるか: `spec/setup/*` にトラブルシュート表はある (例: `paseto-keys.md` 末尾) が、運用障害全般のランブックは未確認
- [x] サンプルコード / examples がビルド可能で陳腐化していないか: `demo/` ディレクトリが実働サンプルとして存在
- [x] ドキュメントが実装と乖離していないか: `spec/setup/service-registration.md` の「HS256 フォールバック撤去済み」等の記述は実装 (`auth-handler.ts`) と一致することを直接確認
- [x] `spec/` が FORMAT_SPEC.md の 6 分類に整理されているか: `data/feature/interface/plan/setup/test` の 6 フォルダに整理され、非正規フォルダは無い
- [ ] ドキュメント充実度 (data/feature/interface/setup/test): `spec/feature/corpus-frontend-ui.md` (899 行) が実質的に `plan/` 相当の内容 (フェーズドロールアウト・オープン論点・日付入り決定ログ) を `feature/` に配置しており「1 機能 1 ファイル」から逸脱。**DOC-001 (Low)**。個人データ保護観点の充実度は `web/REVIEW_PRIVACY_WEB.md` PRIVACYWEB-001 で計上済み (本行では二重計上しない)。
- [x] `feature/` が 1 機能 1 ファイルで主要機能を網羅しているか: `corpus-frontend-ui.md` を除き概ね適合

**指摘 (DOC-001, Low)**: `spec/feature/corpus-frontend-ui.md` — フェーズドロールアウト計画・日付入り決定ログという `plan/` 相当の内容が `feature/` に分類されている (FORMAT_SPEC.md §3/§5 の分類逸脱)。推奨: `spec/plan/corpus-frontend-rollout.md` 等に移動し、`feature/` 側には現状の機能仕様のみを残す。

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | テスト戦略・カバレッジ | C | 1 (High 1) |
| 2 | ライセンス遵守・OSS 帰属表示 | B | 0 (Low 1、未確認 1) |
| 3 | ドキュメント完備性 | B | 0 (Low 1) |

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要
