---
task: cloudflare-enterprise-sso-rebase
project: Cernere
kind: 実装
created: 2026-09-21
memory_links: []
---

# 企業 SSO をパスキー既定認証の authEpoch モデルの上に載せ直す

## 目的

本ブランチ (Cloudflare Access 連携の企業向け認証・プロジェクト限定セッション基盤) は
2026-09-08 起点で、その後 main に入った 0375fb8「パスキー既定認証の端末セッションと
運用者主導のアカウント回復」が認証の内部モデルを入れ替えた。

main 側の変更は次の 3 点で、いずれも本ブランチが触る中核に重なる。

- 失効状態の持ち方に `users.auth_epoch` が入り、`assertUserSessionCurrent` が
  role / MFA 世代 / 端末資格情報まで一括で検査するようになった。
- `generateTokenPair` / `generateAccessToken` / `verifyToken` が async になり、
  発行と検証が DB の現在状態を参照するようになった。
- `approveAuthorization` が承認したセッションの素性 (`UserSessionState`) を
  引数で受け取り、認可 code に束縛するようになった。

一方で本ブランチは、同じ関数群へ企業接続ポリシー (Cloudflare 接続の revision、
組織メンバーの role / joinedAt、認証期間の絶対上限) の検査を足している。
両者は同じ地点を別方向に硬化させているため、衝突 13 ファイル 32 箇所は
「どちらかに倒す」では解けない。**どちらの防御も殺さない**ことが本タスクの要件である。

main の authEpoch モデル・async 化・新しい `approveAuthorization` シグネチャを正とし、
企業 SSO 機能をその上へ実装し直す。

## 完了条件

1. main を取り込み、衝突 13 ファイル 32 箇所を解消する。SSO 側に残っていた
   旧認証モデル依存コード (同期 `generateTokenPair`、1 引数 `approveAuthorization`、
   `authentication` 単独保管) を残さない。
2. OIDC の承認 / code 交換 / userinfo の各地点で、**承認したセッションの失効**
   (`authEpoch` / role / MFA 世代 / 端末) と**企業接続ポリシー**の両方を評価する。
   どちらか一方だけで通過する経路を作らない。
3. 認証事実 (`authentication-evidence`) の正本を承認セッション (`authorization`) 1 か所に
   統一し、auth code / access token record での二重保管をやめる。
4. main が意図して厳しくした判定を SSO 側の旧コードで緩めない。とくに
   `jwt.ts` / `auth-session.ts` / `action-policy.ts` は 1 か所ずつ根拠を確認する。
5. 顔テンプレート・顔写真の保存 (main の efac94d で撤去済み) を復活させない。
6. main 側 0375fb8 が追加したテストと本ブランチのテストの双方が緑であること。
   併せて、両側のゲートを個別に落とすと別々に失敗する回帰テストを追加する。
7. `git diff | anatomia verify` の block ゲート (rule_conformance / duplication) を通す。
8. 仕様 (`spec/feature/cloudflare-enterprise-sso.md`、`spec/data/schema/…`、
   `spec/feature/oidc-provider.md`) を統合後のモデルに合わせて更新する。

## スコープ (編集可ディレクトリ)

- `server/src/auth/`, `server/src/oidc/`, `server/src/enterprise/`, `server/src/http/`, `server/src/ws/`
- `server/tests/`, `frontend/src/lib/`, `spec/`
