---
task: glab-notifier-machine-principal
project: Cernere
kind: 実装
status: planned
created: 2026-09-08
memory_links:
  - GLAB:spec/plan/2026-09-08-consult-notification-machine-auth-design.md
  - Corpus:spec/tasks/2026-09-08-glab-service-routes.md
---
# GLAB 相談通知専用 machine principal と失効契約

## 目的

`glab-discord-notifier` の専用 project credential から最小権限の短命 token を発行し、Corpus の service route で検証可能にする。

## 完了条件

- principal の登録・管理者認可・credential 発行を既存 credentials の所有境界内で提供する。
- audience を GLAB canonical service URL に固定し、TTL 5分、iss/sub/aud/exp/jti、credential generation を token に含める。
- scope は credential に固定した `consult.notification.read` と `consult.notification.ack` のみ。呼出側の任意 scope 昇格を拒否する。
- active signing key と credential generation を独立に照会・失効でき、期限内 token 再利用を許可する。
- rotation の新旧並行検証、principal 単独失効、鍵全体失効を区別し、失効済み旧 generation を拒否する。
- 発行・失効照会不能時の明示失敗、ログ秘密非出力、user API に machine token を流用できない契約を確認する。
- Corpus へ発行/検証/失効 API、error schema、対応 commit と契約テストを引き渡す。

## スコープ (編集可ディレクトリ)

- `server/`
- `tests/`
- `spec/`
