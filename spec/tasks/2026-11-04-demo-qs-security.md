# demo の qs ロック更新

関連タスク: `actio:8eeb12ec-ad53-4a76-bf6f-9f027bbdfdf3`

body-parser 1.20.8 の `qs: ~6.16.0` が許容する 6.16.2 に、ネストした qs のロックだけを更新する。公開 npm registry の version・tarball・integrity を使用し、依存・engine・license が従来と一致することを確認する。

Express 4.22.2 の `qs: ~6.15.1` は 6.16.2 を許容しない。親の更新や overrides は対象外なので、トップレベルの qs 6.15.3 は留保する。今回の更新だけで demo の qs 全件が解消されたとは扱わない。

既存の npm lockfile 形式と親の依存宣言を再利用する。アプリケーション API の変更はない。

## 契約と検証計画

C-1 verifyQsLock(lock): body-parser の qs は要求範囲内の 6.16.2 とし、範囲外の Express の qs と親パッケージは維持する

`augur plan` の調査先行・限定回帰検証に従い、ロック検証と対の回帰テストを追加する。更新後のロックを受理し、旧版への復帰と Express の範囲外更新を拒否するケースを用意する。

許可された最小限の検証として、オフラインのロック検証・差分確認・契約集計を行う。単体テスト一式・サービス起動は実行しない。検証スクリプトはネットワーク API を使用せず、ファイル読込とローカル契約ログ出力のみを行う。npm の lifecycle scripts は実行しない。
