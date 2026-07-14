# 不足機能評価 — Cernere (Web Service)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| レビュー実施日 | 2026-05-17 |

## 1. 機能改善提案

| 対象機能 | 改善提案 | 期待効果 | 優先度 |
|---------|---------|---------|--------|
| operation_logs | 失敗を集約・アラート化 | audit trail 完全性の可視化 | High |
| PASETO key rotation | rotation timeline docs | key rotation ceremony 手順例 (Issue #91 ref) | Medium |
| E2E テスト | WS auth → module_request の E2E | runtime 動作検証、CI 統合 | High |
| Rate limit | endpoint ごとのカスタマイズ | チューニング根拠の明示 | Low |

## 2. 不足機能の提案

| 提案機能 | 必要性 | 優先度 | 影響範囲 |
|---------|--------|--------|---------|
| ローカル開発用 demo idp | OAuth dependency 軽減 | Low | demo/ |
| operation_logs searchable index | コンプラ用、GB 級ログの sequential scan は遅い | Medium | DB schema |
| Redis Cluster / Sentinel 支援 | 本番 HA 対応 | Medium | redis.ts |
| OIDC Discover endpoint | 他サービスから OIDC client として利用可能 | Low | new HTTP endpoint |
| Device fingerprint / trusted device | MFA bypass UX | Medium | schema + table |
