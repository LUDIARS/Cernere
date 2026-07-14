# REVIEW (総合評価) — Cernere

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 分類 | Web サービス (LUDIARS 認証基盤、paseto/HMAC、/auth 系) |
| 対象 | main 直近 4 commit (088ade3, ee09e92, f4f6885, 6c9c867) |
| レビュー実施日 | 2026-06-02 |
| **総合評価** | **C** |

## 概要
脆弱性の最重点項目 (トークン署名検証) は適切に実装。PASETO v4 Ed25519 で秘密鍵を Cernere のみが保持、public key を /.well-known で公開し confused-deputy を防止。token 層 22 本のテストで偽造・改竄・期限切れ・取り違えをカバー。ただし**未実装テストが多く、本番ハードニングと legacy token 廃止計画に gap**。

## 観点別評価

| 観点 | 評価 |
|------|------|
| 設計 | B |
| 脆弱性 | C |
| 実装品質 | B |
| 不足機能 (テスト/ドキュメント) | C |
| 品質保証 | B |

## 重大指摘
- **Critical**: PASETO/JWT env 未設定時の silent fallback (本番で legacy HS256 継続のリスク)
- **High**: project-token の hub_url 未バリデーション / HS256 token に aud claim なし / email・password 入力バリデーション欠落

## 強み
- PASETO 鍵ローテーション (PREVIOUS_PUBLIC_KEYS)、audience claim 必須検証、project-token TTL の明示的差別化 (PASETO 15分 / HS256 60分)
