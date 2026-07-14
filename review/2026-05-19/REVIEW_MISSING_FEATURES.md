# 不足機能評価 — Cernere (2026-05-19)

## 1. 機能改善 — A

本期コミットで完了:
- ✓ PASETO v4 Ed25519 + ISO 8601 timestamp 移行 (#95)
- ✓ Identity Verification Disabled flag with production guard (#100)
- ✓ Vite /.well-known proxy 統合 (#101)
- ✓ Cloudflare Tunnel HMR 対応 (#99)
- ✓ Excubitor-inject docker-compose 清掃 (#102)

## 2. 不足機能 — B

### PASETO 移行 Phase 2 (Issue #91)
- HS256 legacy fallback path がまだ accept → 廃止予定日が未明確
- 推奨: Issue #91 に Phase 2 date を明記、サービス側の置換進捗トラッキング

### E2E テスト
- Passkey + device verify の integration test 未整備
- PASETO 旧鍵 accept (kid v1/v2 並走) の verify テスト推奨

### Operation logs alert
- identity disabled flag 有効時の異常検知ルール無し
- 推奨: operation_logs filtering で `event='user.device.challenge'` カウントベースの alert

### Device revocation UI
- admin 画面からの trusted_device 取消 UI が無い (運用は DB 直接)

### Infisical 統合
- PASETO secret key の Infisical 一元化 (現状: 環境変数直接または手動配置)
