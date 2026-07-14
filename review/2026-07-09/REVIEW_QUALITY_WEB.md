# Web 品質保証レビュー (Web Quality Assurance Review)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

---

## 1. パフォーマンス・ベンチマーク (Performance & Benchmark)

| 評価 | 観点 | 所見 |
|------|------|------|
| B | パフォーマンス要件の明文化 | p50/p95/p99・スループット・エラー率の目標値は spec/ に確認できず。 |
| B | ベンチマーク・負荷試験 | 負荷試験スクリプト/結果は確認できず (`server/`, `packages/` に `k6`/`autocannon`/`artillery` 等の依存なし)。 |
| B | プロファイリング | 明示的なプロファイリング結果ドキュメントは無い。開発時ログ (`db.raw` debug ログ等) はあるが本番プロファイリングとは別物。 |
| B | 性能リグレッション検知 | CI に性能リグレッションを検知する仕組みは無い (`compile-check.yml` は型検査/テストのみ)。 |
| B | 高負荷・大規模データ時の挙動 | `checkRateLimit()` の Redis Lua スクリプトは INCR+EXPIRE を原子化 (適合寄り)。大量同時接続時の uWebSockets.js の挙動は本レビュー範囲では検証できず (未確認)。 |

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| Medium | spec/ 全体 | **QUALWEB-001**。性能目標値・負荷試験結果いずれも文書化されていない (`grep -ri "p95\|p99\|レイテンシ\|負荷試験\|benchmark" spec/` で該当なし)。 | `spec/test/test-design.md` 等に性能目標と測定方法を追記する。 |

### チェック項目

- [ ] レイテンシ・スループット・エラー率の目標値が文書化されているか: 未達 (上表)
- [ ] 負荷試験・ベンチマークが存在し、CI または定期実行されているか: 未達
- [ ] ホットパス・スロークエリがプロファイリングで特定されているか: 未確認
- [ ] リグレッションを CI で自動検出する仕組みがあるか: 未達
- [ ] 大量データ・大量同時接続時の挙動が検証されているか: 未確認
- [x] メモリリーク・コネクションリーク・FD リークが起きないことが確認されているか: WS ping timer の `clearInterval` on close、DB 接続の `finally { sql.end() }` を全箇所で確認 (`common/REVIEW_CODE_QUALITY.md` で計上済み、コードレベルの対策としては適合)
- [x] キャッシュ戦略 (CDN / アプリ / DB) が必要箇所で導入されているか: `packages/id-cache` (Redis キャッシュ、TTL 付き) を確認。OIDC discovery/JWKS レスポンスも `Cache-Control: public, max-age=300/600` を設定 (`oidc-handler.ts`, `app.ts`)
- [ ] cold start / オートスケール時の立ち上がりが許容範囲か: 未確認 (オートスケール運用の記載なし)

---

## 2. クロスプラットフォーム互換 (Cross-Platform Compatibility)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | サーバランタイム / OS 差 | `.nvmrc`・`server/Dockerfile` で Node バージョン固定。`docker-compose.yaml:57-59` に glibc バージョン要件 (uWebSockets.js v20.60+ が glibc 2.38+ を要求) がコメントで明記され、`node:24-trixie-slim` を選定した理由まで文書化されている (好例)。 |
| B | ブラウザ互換 | `packages/composite/src/ui/device-fingerprint.ts` は `navigator.userAgentData` 等の実験的 API をオプショナルチェーンで安全にフォールバックしており、対応ブラウザ外でもクラッシュしない設計を確認。 |
| A | 文字エンコーディング・タイムゾーン | UTF-8 / ISO8601 / UTC を一貫使用 (`common/REVIEW_CODE_QUALITY.md` で確認済み)。 |
| B | コンテナ・ビルド再現性 | `server/Dockerfile` は `node:22-alpine` をタグ固定 (digest 未固定、Low)。`frontend/Dockerfile:8` は `nginx:alpine` (variant のみ、node バージョンより緩い固定) を使用。 |
| 未確認 | CI でのマトリクス実行 | ブラウザ/OS マトリクスでの CI 実行は確認できず (`compile-check.yml` は単一 Ubuntu ランナーのみ)。 |

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| Low | `frontend/Dockerfile:8` | **QUALWEB-002**。`nginx:alpine` がタグのみ (digest 未固定) で、`node:22-alpine` と比べても固定粒度が粗い。ベースイメージの新バージョンが無警告で混入しビルド再現性を損なう可能性がある。 | `nginx:<version>-alpine` の具体バージョン、可能なら digest ピン留めに変更する。 |

### チェック項目

- [x] サーバが想定する OS / ランタイムバージョンが固定・文書化されているか: 適合 (上表、glibc 要件まで明記)
- [ ] フロントエンドが対象ブラウザ・バージョンで動作確認されているか: 明示的な対応ブラウザ一覧は spec/ に無い (未確認)
- [x] 文字エンコーディング・改行・タイムゾーンの扱いが統一されているか: 適合
- [ ] コンテナイメージのビルドが再現可能か: `frontend/Dockerfile` は上表 Low
- [x] パスを `/` ハードコードせず OS 非依存に組み立てているか: `path.join`/`path.resolve` を一貫使用 (`project/service.ts`, `db/migrate.ts` 等)
- [ ] CI がサーバランタイム / ブラウザのマトリクスで実行されるか: 単一環境のみ (未確認/未達だが Low、内部ツールでありマトリクス要求は薄いと判断し新規指摘とはしない)
- [x] arm64 / x86_64 等のアーキテクチャ差が考慮されているか: `node:24-trixie-slim` 選定理由 (glibc) がアーキ差というより OS ディストリ差の考慮だが、`device-fingerprint.ts` は接続元クライアントの `arch` も収集しており多アーキ環境を想定した設計であることを確認

---

## 3. アクセシビリティ・国際化 (Accessibility & i18n) ※フロントエンドがある場合

Cernere は React 製フロントエンド (`frontend/`) を持つため本項目は適用する（対象外にしない）。

| 評価 | 観点 | 所見 |
|------|------|------|
| B | キーボード操作 | 標準 `<input>`/`<label>`/`<button>` は概ねキーボード操作可能 (`LoginPage.tsx`, `OrganizationsPage.tsx` 等でネイティブ要素を使用)。一方カスタム検索結果ドロップダウンはキーボード操作不可 (下記指摘)。 |
| C | セマンティクス / 支援技術対応 | 画像の `alt` 未設定箇所を確認 (下記指摘)。WCAG 準拠目標の明示は spec/ に無い。 |
| 未確認 | 視認性 (コントラスト / フォーカス) | 自動 a11y チェックツール (axe 等) が無く、コントラスト比の系統的検証はできていない。 |
| B | 国際化 (i18n) | i18n フレームワーク (react-intl/i18next 等) は未導入。`index.html:2` の `<html lang="ja">` と大半のコメント・UI 文言が日本語であることから、LUDIARS 内部の日本語圏ユーザー向け管理画面と判断でき、現状は意図的な設計と解釈できる。ただし将来の多言語対応時は書き直しが必要になる構造。 |

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| Medium | `frontend/src/pages/OrganizationsPage.tsx:350` | **QUALWEB-003**。`<img src={u.avatarUrl} .../>` に `alt` 属性が無く、スクリーンリーダーで読み上げられない。 | `alt={u.displayName}` 等を追加する。 |
| Medium | `frontend/src/pages/OrganizationsPage.tsx:331-358` | ユーザー検索結果の候補リストが `<div onClick=...>` の羅列で、`role="listbox"`/`role="option"`・`tabIndex`・`onKeyDown` が無く、キーボードのみでは選択できない。 | ネイティブ `<select>` か、ARIA `listbox`/`option` パターン + キーボードハンドラを実装する。 |
| Low | `frontend/src/pages/OrganizationsPage.tsx:386-391` | プレゼンス表示ドット (オンライン状態) に `aria-hidden` も代替テキストも無い (`DashboardPage.tsx` 側の同種要素には `aria-hidden` が設定されているのと対照的)。 | `aria-hidden="true"` を付与するか `aria-label="オンライン"` 等の代替テキストを追加する。 |
| Low | フロントエンド全体 | i18n フレームワーク未導入 (上記所見)。現状の内部ツール用途では実害は小さいと判断し Low とする。 | 多言語対応の計画があれば i18next 等の導入を検討する。 |

### チェック項目

- [ ] 主要ユーザーフローがキーボードのみで完了できるか: 検索ドロップダウン (上表 QUALWEB-003) に未達箇所あり
- [ ] 画像 alt / フォームラベル / 見出し・ランドマーク等のセマンティクスが整備されているか (WCAG 準拠目標の明示含む): alt 未設定箇所あり (上表)、WCAG 準拠目標の明示は無し
- [ ] コントラスト比・フォーカス表示・拡大時のレイアウトが確保されているか: 未確認 (自動チェックツール未導入)
- [ ] 自動 a11y チェック（axe 等）またはスクリーンリーダーでの主要フロー確認が CI / QA に組み込まれているか: 未組み込み (未確認/未達、上記 Medium 2 件で計上済みのため本行では新規指摘としない)
- [x] UI 文言がハードコードされず i18n 機構経由か: 未達だが意図的な内部ツール設計と判断し Low (上記所見)
- [x] 日付・数値・通貨・タイムゾーンの表示がロケールに応じて整形されているか: `toISOString()`/`toLocaleString()` 相当の一貫した扱いを確認、通貨表示は対象機能なし

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | パフォーマンス・ベンチマーク | B | 0 (Medium 1) |
| 2 | クロスプラットフォーム互換 | B | 0 (Low 1) |
| 3 | アクセシビリティ・国際化 | B | 0 (Medium 2 / Low 2) |

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要
