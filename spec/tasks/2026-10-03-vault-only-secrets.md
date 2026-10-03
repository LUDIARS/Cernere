---
task: cernere-vault-only-secrets
status: implemented
reference: actio:cf561086-398f-476e-a7f4-65608ba771cd
branch: feat/cernere-vault-only-secrets
---

# Cernere の起動と project credential CLI を Excubitor Vault に統一する

## 実装内容

起動時の秘密情報取得を撤去し、Excubitor Vault が注入した必須値の検証だけにした。不足時は変数名だけを通知する。catalog の旧注入設定、Cernere 専用 env-cli 設定、dev スクリプトの dotenv / env:gen 経路も撤去した。互換 compose の旧認証情報も注入済み env の転送に置き換えた。

登録・再発行 CLI は選択した Vault scope に ID / secret を配送し、選択 scope の既存紐付けを保持する。サービス code は必須、Vault project は省略時共有、接頭辞は既存規則と aedilis の EXCUBITOR 例外を維持する。EXCUBITOR_URL / EXCUBITOR_PORT 未設定時は fail-fast とし、管理ポートを新たに固定値として持たせない。

資格情報の配送 callback を DB 保存前に await するため、Vault の取得・紐付け・entry 保存の失敗時は DB を変更しない。CLI は値・API 応答・例外詳細を出さず、固定文だけを標準出力と Vestigium に記録する。

### 再利用探索と採否

- `issueProjectSecret` の生成・bcrypt、`registerProject` / `rotateProjectSecret` の既存 CRUD を再利用。任意の配送 callback を追加し、通常 WS 呼出しの挙動を保持した。
- Excubitor の `vault-router.ts` / `VaultStatus` を読み、共有と project 別の bindings 形式・一覧置換 PUT を確認した。依存コードのコピーや Ex 自体の変更は行わない。
- Cernere に既存の Excubitor URL 解決関数がないため、小さな loopback 専用 resolver を追加。既定ポートの転記は不採用。
- `packages/env-cli` と dotenv-cli は他リポの互換用途があるので保持。Cernere 専用 `env-cli.config.ts` の外部参照は近隣リポの package/config ファイル探索で見つからず撤去した。
- bootstrap の Vestigium 導入パターンと、既存テストの fake Drizzle を再利用した。

### 作業分解

- [x] 契約定義と述語を実装より先に追加し、Augur のテスト計画を保存。
- [x] Vault 配送、DB 保存前の待機境界、CLI と起動検証を実装。
- [x] fetch / DB mock を使った回帰テストを追加。
- [x] 起動、秘密管理、サービス登録、署名鍵の説明と関連設定を更新。
- [x] TypeScript と契約 lint、差分の静的確認。
- [ ] Revisor によるテスト実行・契約の実行証跡確認 (委託本文により実行は審査へ委ねる)。

## 受け入れ条件

C-4 ensureEnv(): Vault 注入の必須値が揃う場合だけ起動を許可し、不足時は変数名だけで失敗する

C-5 mergeVaultBindingNames(existing, added): 既存の紐付け名を落とさず必要名を重複なく追記する

C-6 saveProjectCredentials(credentials, target): Vault への保存完了後だけ戻り、返却値と失敗内容に資格情報を含めない

追加の回帰条件: register / rotate とも Vault の各段階の失敗時に DB 更新・schema migration を行わない。CLI の成功・例外経路で生成した ID / secret を標準出力・ログへ出さない。

## 検証範囲

- `augur plan` の出力: `2026-10-03-vault-only-test-plan.json`。入力境界は CLI 引数・loopback URL・Vault JSON、権限拒否は mocked HTTP 403、異常系はネットワーク失敗と request timeout / redirect 拒否の設定に対応づけた。公開 API の追加はないため新規の対外 rate-limit 実装は対象外。
- `tsc --noEmit -p server/tsconfig.json`: 成功。
- 追加した 4 テストファイルと CLI を明示対象にした strict TypeScript 静的チェック: 成功。
- `augur contracts lint --project . --json`: 6 契約、findings なし。
- `git diff --check`: 成功。
- 単体・統合・起動テストは未実行。実データの登録・再発行、Vault の書き換え、サービス起動・再起動は行っていない。
- `augur inject apply --project . --rule contract-wrap --diff-base main` は、最初に作業領域外のログ書込で EPERM。ログを worktree 内へ変更した再試行では既存の `augur.inject.json` 不在により失敗した。`@ludiars/log-weaver` のランタイム依存も既存 server にない。契約述語は実装前に追加済みだが、実行観測を満たしたとは扱わない。
- `DELEGATION_STARTED_AT` がこの実行環境では未設定だったため、Cc run の `created_at` をその値として集計した。6 契約はいずれも `uncovered (not-injected)` / calls 0。既存 C-1〜C-3 の未観測も変更せず報告する。

## 残る制約

Vault と DB は分散トランザクションではない。secret PUT の応答喪失や Vault 成功後の DB 失敗では再発行による復旧が必要。途中までの紐付け・ID 更新は巻き戻さない。既存の非公開 API に原子的更新や旧平文の取得口を追加する変更は行わない。同じ service/scope の同時編集は一覧置換 API の競合を起こすため、運用では直列に実行する。

通常の WS 登録 / 再発行 API は対象外で挙動を保持する。新しい CLI が reactivation になった場合は既存資格情報・Vault 紐付けを変更しない。

提出境界は Concordia 経由の commit と Revisor local PR、status 報告。push / merge / auto-merge 設定 / main 更新は行わない。
