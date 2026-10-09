# Cr workload authority

参照: actio:907da54c-c82e-4a3c-83e0-19d330192d52
関連: actio:7a9649fb-f582-4082-b841-922ba798139b
仕様: [workload-authority](../feature/workload-authority.md)

- [x] 契約・述語を実装前に追加
- [x] 専用 schema / 冪等 migration / 管理 WS を追加
- [x] token 発行と認証付き introspection を追加
- [x] TLS transport と秘密保護を追加
- [x] 回帰テストを追加し、許可された隔離 workload suite 70/70 成功
- [x] Concordia broker commit と既存 PR2521 への提出（再審査・マージは親側で進行）

## 契約

C-14 workloadClaims(snapshot, now): 有効な主体・宛先・双方の鍵・完全一致 grant・token の期限と失効を満たす場合だけ Ex wire claims を返す
C-15 parseWorkloadRegistration(input): site/workload ID と Ed25519 SPKI 公開鍵だけを受け付け秘密鍵・自己権限指定を拒否する
C-16 parseWorkloadGrant(input): 操作と資源の組合せを検証し vault keys を管理者の完全一致 allowlist に限定する

## 初回の検証計画（隔離実行許可前の履歴）

Augur plan の baseline characterization 提案を具体化し、既存 service-token テストを保持した上で、上記3契約に対の純粋関数テスト、authority の store/credential mock テスト、管理 dispatch / HTTP 境界のテストを追加する。期限、未来 iat、全失効対象、宛先 credential 不一致、未知 field、秘密鍵、service token、DB failure を含める。テスト・サービス起動は禁止のため実行しない。契約集計は実観測の未充足を報告する。

## 実施・制約（初回記録と現在の検証）

- `tsc --noEmit --project server/tsconfig.json` と追加テスト群の静的型検査、`git diff --check` は成功。テスト、実 DB migration、実登録、起動、配備は未実行。
- Augur contract-wrap は C-14〜C-16 の3箇所へ注入成功。`VESTIGIUM_LOGS_DIR` をこの worktree の `logs` に限定し sandbox 外ログ書込みを回避した。
- 初回注入は runtime 未導入と rootDir 外述語 import で除去。継続修正で pinned Lapilli submodule と server dependency/build chain を追加し、C14〜C16 を server 内の述語と observe wrapper へ接続した。runtime build と server 全体の静的型検査は成功（既存 main dependency を参照する一時検査設定を使用）。実行証跡は未取得。
- Cc counterpart に合わせ ai-spawn/ai-inject の exact thread grant を追加。固定テスト credential は実行時の dummy 乱数へ置換し、認証失敗の期待値を維持した。回帰ケースは追記したが実行していない。
- offline lock-only 更新は成功。offline dependency install は npm cache の EPERM で失敗したため、通常 npm ci/build の再現確認は未実施。サービス、テスト、live credential、migration は操作していない。
- 2026-10-07 人間の隔離テスト許可後、worktree内の独立dependenciesへnpm ci --include=dev --ignore-scriptsを実施し、既存Vestigiumと追加Lapilliの固定submoduleを初期化。Vestigium buildとserver通常npm run buildが成功した。bootstrap:serverを追加し、bootstrap/CIはserver依存をscript無効で導入後にruntime/serverを明示buildする。production envでもdev依存を落とさない。Revisorのworktree準備はsubmoduleを自動初期化しないため、review registryのbare install/testだけでは不十分であり親へsetup stage追加を報告した。
- 17:15 JST、cc-test claim/release付きでworkloadの5 suite70/70成功。register/grant/各revokeの6操作について、getUserStateなし401とsession_expired403の双方でworkload insert/updateが0となる回帰ケースを追加した。観測C-14:32、C-15:3、C-16:7、違反/predicate例外0。ログはworktree logs/security-regression-20261007/weaver.jsonl。実サービス・production DB・live credential・migrationは未操作。
- Cc の実登録を読み取り確認した結果、Cr は `revisor` workflow、review gate は有効。Actio 本文の親 workflow=GitHub / Rv off という記述との差異を提出報告へ明示し、実登録と今回の local PR 指示に従う。設定変更や push はしない。
- Cr タスク参照は上記既存 ID を維持。Cc task creation API には parent/child 指定がないため Ex task の child 関係を捏造しない。関連参照と session task-link を記録した。

## PR 説明

拠点ごとの workload 主体・Ed25519 公開鍵・管理者 grant を専用 DB に分離し、Ex wire に一致する60秒 token と宛先本人によるオンライン introspection を追加する。主体・宛先・鍵・grant・token の失効を毎回照合し、既存 project service token を workload として受理しない。

既存 Drizzle、bcrypt credential、SHA256 token hash、公開鍵正規化、WS session/admin guard を再利用。project PASETO は grant と失効の境界が異なるため流用せず、オンライン限定 opaque token を採用した。

許可された隔離 workload suite は5 suite70/70成功。通常 bootstrap:server と server build、静的型検査、git diff --check も成功。契約観測 C-14:32、C-15:3、C-16:7、違反・predicate例外0。管理操作の missing/expired session は workload 書込み0を確認した。migration と TLS 設定は未配備で、実サービス・production DB・live credential は未操作。再審査とマージの完了は親側の確認待ち。

## 再審査指摘への追補

- 旧固定wrong-namespace token fixtureを、v4.public namespaceを保つ実行時dummy生成へ変更。service/project tokenをworkloadとして拒否する期待値は維持し、漏出findingの抑制は追加しない。synthetic snapshot fixtureへSPEC-WORKLOAD-AUTHORITY対応注釈を追加。
- cc-test claim付きで同workload5suite70/70再成功、server型検査とgit diff --check成功。共有wire5flow/21mockHTTPの証跡は親へ報告済み。
- Revisor bootstrap-server/testは成功したが後続installのprepareが失敗した前attemptは不合格として保持。親がregistry installへignore-scriptsを追加し、bootstrapで明示buildする順序に整合。次headの審査とhold100の扱いは親側のgate確認待ち、merge完了とは扱わない。

## 配備時影響の除去 (2026-10-09)

参照: actio:f2b7f4d4-d3ef-43b0-91d4-3544690efb92（親 actio:925ce186 / actio:7a9649fb 配下）

- [x] workload TLS を `CERNERE_WORKLOAD_TLS_PORT` の別待受 (SSLApp) へ分離し、一般認証の app を常に平文に固定
- [x] 平文 app の workload 拒否・TLS 一部設定の起動エラー・既存ルート / CORS 保持の回帰テスト
- [x] migration dry-run (`npm --prefix server run migrate:dry-run`、1 トランザクションで必ず ROLLBACK、トランザクション不可の文は実行せず停止)
- [x] 配備前確認と戻し方を [workload-deploy](../setup/workload-deploy.md) に記載

C-17 workloadListenerConfig(env, listenPort): TLS 証明書・鍵・workload ポートが全て揃うときだけ一般待受と別ポートの workload TLS 待受を返し、全て未設定なら null、片側設定は起動構成エラーにする
C-18 concludeMigrationDryRun(result): 未適用 migration の dry-run 結果は COMMIT せず、トランザクションを開いた場合は必ず ROLLBACK 済みで、トランザクション不可の文があれば何も実行せず blocked で停止したものに限る

再利用: ステートメント分割・冪等スキップ・migrations 探索は `runMigrations` から `server/src/db/migration-files.ts` へ切り出して dry-run と共有した (規則の二重実装を避けるため)。workload ルート登録 `registerWorkloadRoutes` と HTTP 補助関数はそのまま両待受で再利用し、tls 引数は待受の種類だけから決める。

検証: cc-test claim/release 付きで server 単体テスト全体 97 files / 795 tests 成功、`tsc --noEmit` 成功。`LOG_WEAVER=1` で C-17 ok×2・C-18 ok×4 を観測、違反・predicate 例外 0 (worktree `logs/security-deploy-20261009/weaver.jsonl`)。Augur report は augur.inject.json 不在のため従来どおり全契約 `not-injected`。dry-run の実 DB 実行、サービス起動、TLS 実接続、実鍵は未実施。
