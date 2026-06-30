# 設計レビュー — Cernere (2026-05-19)

## 1. 設計強度 — A

PASETO v4 Ed25519 移行 (#95) は HS256 共有 secret から非対称鍵に切替え、Hub 漏洩 = 偽造能力漏洩のリスクを根本的に低減。`server/src/auth/paseto.ts` で kid + previous keys による段階移行 (key rotation ceremony) を実装、移行 window は project-token TTL 15 分で十分。

該当箇所:
- `server/src/auth/paseto.ts` — Ed25519 KeyObject 化、kid 管理、verifyKeys 配列で旧鍵併用
- `spec/security_design.md` — 鍵ローテーション手順

## 2. 設計思想の一貫性 — A

4 層防御 (token verify / Redis TTL / state check / resource ownership) を一切変更せず、機能追加・修正は層内に閉じている。識別子バイパス (#100) は emergency path として layer 下部 (device verify) に追加され、上位 PASETO 認証層は不変。

該当箇所:
- `server/src/auth/identity-verification.ts:135-146` — checkDevice の early return
- 既存の 4 層境界は無変更

## 3. モジュール分割度 — A

`server/src/auth/{paseto,identity-verification}.ts`, `server/src/config.ts`, `server/src/http/auth-handler.ts` の責務分離が明確。Vite proxy 設定追加 (#101) も既存 rule (`/api`, `/auth`, `/ws/project`) と同パターンで、`frontend/vite.config.ts` 内に閉じる。

該当箇所:
- `server/src/auth/paseto.ts` — 署名・検証の単一責務
- `server/src/auth/identity-verification.ts` — device fingerprint + challenge

## 4. Identity Verification Disabled Flag の設計

`CERNERE_IDENTITY_VERIFICATION_DISABLED` (#100) は config.ts 初期化時に `isProduction() && raw` で throw → 本番誤設定を絶対防止。flag 有効時も `logAuthEvent('user.device.trusted')` で監査ログを残す。DB 未更新 (trusted_devices 登録なし) → 次回 login で再検証。

該当箇所:
- `server/src/config.ts:79-87` — production guard
- `server/src/auth/identity-verification.ts:135-146` — early return + audit log
