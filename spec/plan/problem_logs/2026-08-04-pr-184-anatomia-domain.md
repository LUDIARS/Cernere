# Revisor PR #184 が OIDC 鍵管理のドメインを解決できない

## 概要

- 発生日: 2026-08-04
- 対象: Cernere / Revisor local PR #184
- 症状: 登録テストは成功したが、対象ドメイン未定義とアーキテクチャ違反が残り `action_required` になった。

## 原因

既存の `oidc-provider` ドメインは `server/src/oidc` と UI だけを対象にしており、id_token 署名鍵を実装する `server/src/auth/oidc-*` と migration 039 を含んでいなかった。また、Anatomia の組み込み説明用 `transition-guard-example` が、変更前から存在する `dispatch -> getUserState` を禁止状態遷移として誤検出した。

## 対応

- OIDC署名鍵の解決・永続化・JWKS公開を `oidc-provider` の `oidc-signing-keys` module として定義した。
- `.anatomia/domains/oidc-provider.review.json` にレビュー用の責務、対象pattern、spec参照を追加した。
- Cernere の状態遷移を表していない組み込み例を、同名の空policyで上書きした。

## 検証

- JSON の構文と `git diff --check` を静的に確認する。
- セッション方針に従い、ローカルの単体・統合・起動テストは実行しない。Revisor の登録済みテストと再審査で確認する。

## 再発防止

機能固有の鍵やmigrationを既存ドメインへ追加する場合は、プロトコル実装だけでなく鍵ライフサイクルを含む責務とpathをtaxonomy・ontology・Anatomia定義で同時に更新する。
