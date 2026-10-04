## 実装内容

Vault-only 移行後にシェルから起動した運用 CLI が DATABASE_URL 不足で停止する問題に対応した。register / rotate / grant-project-data-sharing / register-oidc-client に共通の secret-agent 環境補完を追加し、config / DB / Redis の import より先に実行する。

既存 env は空文字も含め保持し、応答全体と必須値を検証してから不足分を反映する。HTTP 失敗、通信・JSON・token ファイルのエラーは固定分類と既知キー名だけを返す。サーバ bootstrap と実データは変更していない。

再利用探索では既存 `resolveVaultEndpoint` の loopback 制約・明示 URL / PORT 解決を採用した。Actio の token 解決順序に合わせ、直接 env → 指定 UTF-8 ファイル → APPDATA / homedir の既定ファイルとした。Actio の現行ソースには既定ポートがないため番号は追加していない。サーバ専用 ensureEnv は OAuth / JWT 等を要求するので、DB 操作だけの CLI には流用しない。

## 受け入れ条件

C-7 missingScriptEnv(existing, received): 既存値を保持し、妥当な応答から未定義の環境変数だけを補う
C-8 ensureScriptEnv(required, options): 必須環境変数の充足後だけ成功し、失敗は固定分類と既知キー名だけで報告する

## 検証範囲と未完了事項

Augur plan に沿い、モック fetch による補完・no-op・エラー分類・秘密値非出力・トークン優先順位・DB import 順序のテストを追加した。契約 lint は findings 0、差分チェックは問題なし。単体・統合テスト、起動、実データ操作は指示により未実行。

契約定義・述語は実装前に作成した。契約注入2箇所は適用できたが、既存にない `@ludiars/log-weaver` の registry 取得が sandbox EACCES で拒否されたため、CLI を壊す未解決 import は除去した。契約 runtime の導入と再注入、および審査環境での契約実行証跡が未完了。Augur 集計は not-injected / calls 0 として報告する。

関連: actio:a6b1001c-e9f9-4822-9f8a-42aea5646179
