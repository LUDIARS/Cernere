# 不足機能評価（共通） (Missing Feature Evaluation — Common)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

> 開発チーム自身が `spec/plan/commit-plan.md` に 46 件の改善 PR (C1-C9 / H1-H17 / M1-M20 / #64 系 14 件) を体系的に計画・優先度付け済みであることを確認した。本ドキュメントはその内容と重複しない範囲で、本レビューの調査過程で新たに気付いた項目、または `commit-plan.md` に無い観点を中心に記載する。`commit-plan.md` 記載分は該当 ID を引用し二重立案しない。

---

## 1. 機能の改善提案 (Feature Improvement)

| 対象機能 | 改善提案 | 期待効果 | 優先度 |
|---------|---------|---------|--------|
| composite 認証フロー (`redirect_uri`/`origin`) | 登録済み URL の完全一致許可リストを `oidc_clients.redirectUris` と同じパターンで導入する (`web/REVIEW_VULNERABILITY_WEB.md` VULNWEB-001 の恒久対策) | オープンリダイレクト/postMessage 経由のセッション奪取を構造的に防止 | High |
| セキュリティヘッダ (`frontend/nginx.conf`) | CSP (`frame-ancestors` 含む) / X-Frame-Options / HSTS / Referrer-Policy / X-Content-Type-Options を追加 (`spec/plan/commit-plan.md` C9 と同一内容、参照のみ) | クリックジャッキング・XSS 影響範囲の縮小 | High (commit-plan.md C9 準拠) |
| フロントエンド WS トークン受け渡し | `ws-client.ts` を `app.ts` が既に対応済みの `Sec-WebSocket-Protocol` 方式に移行し、URL クエリでの token 送信・`console.log` での URL 出力を廃止 (`spec/plan/commit-plan.md` #64 の `ws-token-via-subprotocol` と同一方向、フロント側の未追従を指摘) | アクセスログ・ブラウザ履歴・devtools コンソールへの生トークン露出を排除 | High |
| CI ワークフロー | `packages/id-cache`・`packages/id-service`・`packages/service-adapter`・`packages/composite` の typecheck/test を `compile-check.yml` に追加、secret スキャンステップを追加 | 公開パッケージの品質ゲート強化、ハードコード秘密の再発防止 | High |

### 観点

- パフォーマンス最適化: 対象機能なし (本レビュー範囲では優先度の高い最適化余地は確認できず)
- ユーザ体験の向上: composite ログインのエラーメッセージは概ね親切 (日本語で状況説明) — 追加提案なし
- テスタビリティの向上: 上記 CI 項目参照
- 運用負荷の軽減: 下記「不足機能」§2 の SLI/SLO・バックアップ手順を参照

---

## 2. 不足機能の提案 (Missing Feature Proposal)

| 提案機能 | 必要性の根拠 | 実装優先度 | 想定影響範囲 |
|---------|------------|-----------|------------|
| 個人データ保護インベントリ (`spec/data-schema.md` 相当) | RULE_DATA_SCHEMA.md §4 が要求する「データ名/種類/権威ソース/保存先/保護要否/保護方法」の一覧表が存在しない。Cernere は LUDIARS の個人データ単一情報源であり、この一覧の不在は組織全体のプライバシー統制上のギャップになる (`web/REVIEW_PRIVACY_WEB.md` PRIVACYWEB-001 参照) | High | spec/data/ |
| 法令適用範囲の明文化 (GDPR / 個人情報保護法) | `spec/` 全体を検索したが GDPR は 1 行の設計動機記述のみ、個人情報保護法 (APPI) の言及は 0 件。適用有無の判断自体が文書化されていない (`web/REVIEW_PRIVACY_WEB.md` PRIVACYWEB-002 参照) | High | spec/, README.md |
| SLI/SLO 定義・障害時ランブック | `spec/setup/` にトラブルシュート表は部分的に存在するが、SLI/SLO の数値目標や全社共通のインシデント対応ランブックは未確認 (`web/REVIEW_IMPLEMENTATION_WEB.md` IMPLWEB-003 参照) | Medium | spec/setup/ or 新規 spec/operations.md |
| 負荷試験・性能目標のドキュメント化 | p50/p95/p99 のレイテンシ目標や負荷試験結果が spec/ に存在しない (`web/REVIEW_QUALITY_WEB.md` QUALWEB-001 参照) | Medium | spec/ |
| readiness ヘルスチェック | `GET /health` (`app.ts:547-549`) は liveness のみ (プロセス生存確認)。DB/Redis 接続性を含む readiness エンドポイントが無く、デプロイ時のロールアウト安全性判断がしづらい | Medium | server/src/app.ts |

### 観点

- 入力バリデーションの不足: `common/REVIEW_VULNERABILITY.md` VULN-002 参照 (脆弱性軸で計上済み、本行では重複記載しない)
- エラー通知・アラートの欠如: `[paseto] ... falling back to HS256 only` 等の重要な設定不備ログがコンソール出力のみで、監視アラートに接続されているか未確認
- 監査ログの不足: `operation_logs` は充実 (全 WS コマンドを記録)。不足は確認されず
- 死活監視・自己診断の未実装: 上表 (readiness ヘルスチェック)
- レート制限・スロットリングの未実装: 主要エンドポイントに Redis ベースのレート制限あり。不足は確認されず
- バッチ処理・リトライ機構の不足: `service_tickets`/`refresh_sessions` の期限切れレコードを削除する cron が無い (`spec/plan/commit-plan.md` M8/M19 として既に自己認識・計画済みのため本ドキュメントでは新規提案としない)
- ドキュメント・仕様の不足: 上表 (個人データインベントリ・法令適用・SLO)

---

## 総合評価

| # | レビュー観点 | 指摘数 | 優先度別内訳 |
|---|------------|--------|------------|
| 1 | 機能改善 | 4 | High: 4 / Medium: 0 / Low: 0 |
| 2 | 不足機能 | 5 | High: 2 / Medium: 3 / Low: 0 |

**優先度基準:**
- **High**: 不具合・セキュリティ・データ保全・法令対応に直結する
- **Medium**: 品質・運用効率・開発速度を明確に改善する
- **Low**: 利便性・体験の向上に留まる

> 本ドキュメントの 2 観点は A〜D の評価軸を持たない。総合評価表では評価を「-」とし、指摘数と優先度内訳のみ記載する。
