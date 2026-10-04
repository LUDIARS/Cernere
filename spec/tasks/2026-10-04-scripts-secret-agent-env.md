# 運用スクリプトの secret-agent 環境補完

- 参照: actio:a6b1001c-e9f9-4822-9f8a-42aea5646179
- 対象: register / rotate / grant-project-data-sharing / register-oidc-client
- 背景: Vault-only 移行後、シェル起動した運用 CLI に DATABASE_URL 等がなく登録に失敗する回帰。

## 契約（実装前に定義）

C-7 missingScriptEnv(existing, received): 既存値を保持し、妥当な応答から未定義の環境変数だけを補う
C-8 ensureScriptEnv(required, options): 必須環境変数の充足後だけ成功し、失敗は固定分類と既知キー名だけで報告する

## 作業分解

- [x] 共通の endpoint / token 解決と環境補完を追加する。
- [x] 各 CLI の config / DB / Redis import を補完後へ移す。
- [x] モック fetch の回帰テスト、既存 CLI テスト、import 順序の検証を追加する。
- [x] README と運用仕様を更新する。
- [ ] Concordia コミット依頼、Revisor local PR、委託 status を報告する。

## 設計判断と検証境界

既存 resolveVaultEndpoint を再利用する。Actio の現行 endpoint.ts は EXCUBITOR_URL のみで既定ポートを持たないため、ポート番号を新設しない。Cernere 既存の明示 EXCUBITOR_PORT 対応は維持する。
トークン解決は Actio 同様、直接 env → 指定ファイル → APPDATA / homedir の既定ファイルの順とする。
必須値は project 系では DATABASE_URL / REDIS_URL、OIDC 登録は DATABASE_URL のみ。JWT 等サーバ専用の必須値は要求しない。
既存値（空文字を含む）は上書きせず、不正・不足値は固定分類で失敗する。応答全体の検証と必須値の充足を確認してから env を更新する。
テスト実行・実データ操作・サービス起動はタスク本文に従い行わない。契約の実行証跡は審査側に委ね、集計の未充足を成功へ書き換えない。
問題ログの main への記録は「指定 worktree のみ編集」という今回の指示に従い行わず、この作業記録に回帰の事実を残す。

## 検証記録・制約

- Augur plan を同ディレクトリの `2026-10-04-scripts-secret-agent-env-test-plan.json` に保存した。回帰条件に対して3本の scripts テストを追加し、既存 vault-cli テストを更新した。
- `augur contracts lint --project . --json`: 8契約、findings 0。
- `git diff --check`: 問題なし。
- ユーザ指定によりテスト・サービス・実データ操作は実行しない。
- 契約注入は追加した augur.inject.json と `ANATOMIA_VESTIGIUM=0` で実行でき、C-7 / C-8 の2箇所へ適用成功した。ただし `@ludiars/log-weaver` は既存依存に含まれず、registry への接続も sandbox の EACCES で拒否された。未解決 import による CLI 破損を避けて注入を remove した。契約 runtime の導入・再注入・実行証跡の取得が残る。
- `DELEGATION_STARTED_AT` が未設定のため、Cc run の created_at を開始境界として `contracts report --acceptance --json --since` を集計した。C-7 / C-8 と既存6契約は not-injected / calls 0。未充足を成功に置換しない。
