# REVIEW_DESIGN — Cernere

**評価: B**

## 適切な設計決定
- PASETO 鍵ローテーション: `CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS` で旧公開鍵を複数登録
- audience claim 必須検証で confused deputy を strict に防止
- 常時接続 WebSocket + Redis state で破壊的操作をゲート (4 層防御)
- project-token TTL を PASETO 15分 / HS256 60分で明示的に差別化

## 設計課題

| # | 重大度 | 内容 |
|---|--------|------|
| 1 | High | HS256 token に aud claim がない → legacy service が token を横取り再利用のリスク (jwt.ts:97-107) |
| 2 | Medium | project-token 発行時 hub_url のフォーマットバリデーションなし (trim のみ) |
| 3 | Medium | HS256 廃止タイムラインが記載なし (段階移行の終端不明) |

## 4 層防御
WS upgrade 時に Layer 1+4 を統合検証、commands.ts で Layer 2+3 を集中ガード。設計思想は明確だが、各層の failover をテストで保証する必要がある。

**総合: B**。鍵管理・confused deputy 防止の設計は堅牢。HS256 legacy の扱いと廃止計画が弱い。
