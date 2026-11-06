# サービス向け authCode を発行先と端末に束縛する (互換なしで切り替え)

- 日付: 2026-10-30
- 経緯: 2026-10-29 の外部公開の裏取りで残った所見 (反証役 2 名で成立を確認)。neco 決定「設計してから切り替える」
  「互換性は脆弱性の元なので切り捨てよ」。移行期間・旧方式の併用は作らない。
- 対象: Cernere server / frontend の Composite 画面 / `packages/composite` / `packages/native-composite`、
  Composite ログインを使う全サービス (2026-10 時点: GLAB、Aedilis、Tendentia、Tokyo2070)

## いまの問題

Composite ログインの authCode は「誰が持っていても 1 回交換できる引換券」になっている。

1. `POST /api/auth/exchange { code }` は認証が要らず、交換相手も確かめない。
2. 交換で返るのは Cernere 全体で使える `user_access` と 30 日の refresh token。
3. 発行先の確認は全サービス共通の許可リスト (`CERNERE_COMPOSITE_ALLOWED_ORIGINS`) だけで、
   どの project に向けた code かを持たない。
4. 許可したオリジンのどれか 1 つで XSS が起きるか、そのサービスの backend が侵害されると、
   code を横取りして Cernere の token を得られる。そこから `composite-session-code` で他サービス用の code も作れ、
   全サービスへ横に乗っ取りが広がる。

## 決めたこと

### 1. 発行先はプロジェクト単位で登録する

- 管理者所有の `schema_definition.composite_origins` (配列、https のオリジンの完全一致) を project ごとに持つ。
  identity_claims / service_scopes と同じく、project client の update_schema では保存しない。
- サービス向け code の発行は `client_id` (project の client_id) と送り先のオリジンを受け取り、
  そのオリジンがその project の `composite_origins` に入っているときだけ発行する。
- 全サービス共通の `CERNERE_COMPOSITE_ALLOWED_ORIGINS` は**廃止**する。frame-ancestors の許可も
  全 active project の `composite_origins` の和から作る。
- 本番で http のオリジンとループバックは登録できない (開発用は cernere-test の project にだけ登録する)。

### 2. code は PKCE で開始した端末に結び付ける

- サービスの画面がログインを始めるときに `code_verifier` を作り、`code_challenge` (S256) を
  `/composite/login?client_id=...&origin=...&code_challenge=...&state=...` に付ける。
- Cernere は code に `{ projectKey, origin, codeChallenge, subject }` を結び付けて保存する (TTL 60 秒、1 回きり)。
- silent SSO (`composite-session-code`) も同じく `client_id` と `code_challenge` を必須にする。
- `code_challenge` の無い要求は受けない (plain も受けない)。

### 3. 交換はサービスの backend だけが、自分宛ての code だけを交換できる

- `POST /api/auth/exchange` は project token (`Authorization: Bearer <project token>`) を必須にし、
  body は `{ code, code_verifier }`。
- 交換が通る条件: project token の project = code の project、PKCE の検証が通る、未使用。どれかが崩れたら 401
  (どれが崩れたかは返さない)。
- 返すのは **そのサービス用の token だけ**:
  `{ user: { id, displayName, email, role }, projectToken: <PASETO user_for_project, aud=project の hub_url, 15 分> }`。
  Cernere 全体の `user_access` / refresh token は返さず、交換のために refresh_sessions の行も作らない。
- サービスはこの後、自分のセッションを自分で持つ。期限切れの再認証は silent SSO で新しい code を取り直す。
  Cernere の refresh token によるサービス側の延長 (`packages/composite` の `refresh()`) は**廃止**する。

### 4. Cernere 自身のログイン (audience = cernere) は分けたまま

- Cernere 自身の画面 (`/login`) の code は、Cernere の画面のオリジンからの交換だけを受ける今の判定を残す。
- ここにも PKCE を必須にし、Cernere の画面が verifier を持つ。サービス向けの交換口とは別の口にする
  (`POST /api/auth/exchange/self`)。

### 5. kiosk の限定交換口は別の scope のまま

- `POST /api/auth/code/exchange` (Ostiarius の kiosk) は PR #3549 の scope (`auth-code:kiosk-exchange`) で守る。
  code を発行するとき kiosk 用であることを記録し、サービス向け・Cernere 向けの code は kiosk の口で交換できないようにする。

## 消すもの (互換は残さない)

- 認証なしの `POST /api/auth/exchange`、`code_challenge` の無いログイン・silent SSO
- 交換で Cernere の `user_access` / refresh token を返す処理と、そのための refresh_sessions の行
- `CERNERE_COMPOSITE_ALLOWED_ORIGINS` と、それを読む config・catalog の値
- `packages/composite` の `refresh()` と、`exchange()` の旧戻り値 (`accessToken` / `refreshToken`)
- 旧形式の authCode (用途・project の無いもの) の読み込み

## 切り替えの順序

互換を残さないので、Cernere を切り替えた瞬間から旧方式のサービスはログインできなくなる。
停止時間を短くするために、先に全部をそろえてから一度に入れ替える。

1. Cernere: 本設計を実装する PR (server / frontend / packages)。マージはするが反映 (deploy) はしない。
2. 各サービス: 新しい `packages/composite` に合わせる PR を、サービスごとに用意する
   (login 開始で PKCE、backend の exchange に project token と verifier、自前セッション、refresh の撤去)。
3. 管理者: 各サービスの project に `composite_origins` と `hub_url` を登録する。
4. 切り替え: Cernere を deploy → 各サービスを deploy。この間は Composite ログインが止まる (数分を想定)。
5. 確認: 各サービスでログインし、交換で Cernere の token が返らないこと、
   他サービスの token では交換できないことを確かめる。

## テストで確かめること

- 他の project の token で交換すると 401、verifier が違うと 401、2 回目の交換は 401
- `composite_origins` に無いオリジン・http のオリジンへは発行しない
- 交換の応答に `accessToken` / `refreshToken` が含まれない
- kiosk 用でない code は kiosk の口で交換できない
- `code_challenge` の無いログイン・silent SSO は 400

## 実装時の契約の補足 (2026-11-06)

- global と Composite の passkey login begin を分離する。challenge に用途・project/PKCE・
  戻り先・期待署名 origin を保存し、finish で同一性と暗号署名を検証する。
  global/self と credential 登録は Cr 自身の署名 origin のみ。service/kiosk は対象 project
  または hosted Cr origin のみとし、全 project の origin 和を本人認証の許可に使わない。
  service iframe の topOrigin は署名検証後に対象 project と照合する。PC enrollment が必要なら
  新しい self ceremony を始め、サービスの challenge を self に変更しない。
- `hub_url` は `schema_definition.hub_url` に登録する管理者所有の canonical origin とする。
  現行 schema に専用の保存先が無かったため追加する。`endpoint.url` や要求 body からの補完はしない。
  `composite_origins` と併せ project client の `update_schema` から変更・削除できない。
- 本番登録は path/query/fragment/資格情報/ワイルドカードの無い HTTPS origin に限る。
  HTTP・loopback の例外は development の `cernere-test` project だけとする。
- Redis の authCode 記録は版 1 の用途別 binding と本人の失効世代・認証事実を持つ。
  access/refresh token を作るのは交換時だけとし、サービス向け交換では refresh 行を作らない。
  不正な交換の試行も GETDEL でコードを消費する。失敗後の自動再試行はしない。
- 交換時にも project credential の現行世代、active、現在の登録 origin、本人・端末の失効、
  サービスへの利用許可と現在の同意を検査する。通信・DB 障害を古い許可の cache へ戻さない。
- サービス用 PASETO には `compositeGrant: { version: 1, id }` を署名して入れる。
  opaque id の先に Cr が元の本人・端末・認証世代を 15 分だけ保持する。
  この参照だけで重要操作や機密閲覧を許可しない。サービス自身の対象データの認可も必須。
  サービスセッションとの束縛・操作別 one-time proof・照会不能時の fail-closed は後段の共通 guard の責務。
- `/login` の verifier は Cernere の画面のメモリに持つ。サービスの verifier はサービスの画面が持つ。
  popup/frame は origin/source/state を照合し、サービス backend へ code と verifier を渡す。
  SDK の戻り値は `{ projectToken, user }`。SDK は自己署名の代替 token や refresh を提供しない。
- ダッシュボードの `open_url` は認証コードを URL に載せず、サービスの開始画面へ移動する。
  移動先で PKCE を開始し silent SSO を行う。サービス以外が verifier を作って引き渡す経路は置かない。
- kiosk の発行要求は `code_audience: "kiosk"` を明示する。本人認証、登録 project/origin、
  管理者所有の `auth-code:kiosk-exchange` scope が揃うときだけ kiosk 用 binding を作る。
  交換口では同じ project の現行資格情報を要求する。管理者 user token による代用はしない。

### 一斉切替に必要な consumer の棚卸し

実装中は配備しない。GLAB の共通認証は LUDIARS/Corpus 所有であり、GLAB 側で submodule を直接編集しない。
下流は [SPEC-COMPOSITE-DELEGATION](../feature/composite-operation-delegation.md) の30秒one-use許可へ移行する。
旧 `/api/auth/project-token` の user token 契約への互換 fallback は設けない。target の明示scheme検査と
最新resource ACLも揃うまで配備不可。標準の一度限り許可とオンライン照会を再利用し、新しい署名方式は作らない。
Corpus の本人全体 token の保持・5 分 cache・下流 token 発行をサービスセッション契約へ揃える必要がある。
GLAB `plugins/connector-authorization.ts` → `TokenProvider.getDownstreamToken` の下流委譲
(`spec/interface/downstream-authorization.md`) も合わせて移行する。予約・施設・通話・動画の対象データ認可を
新しい delegation 契約へ残し、本人 token の除去で下流呼び出しを匿名 fallback に切り替えない。
GLAB / Aedilis (meetings の直接交換を含む) / Tendentia / Tokyo2070 に加え、kiosk の Ostiarius と
`packages/native-composite`、その他の共有 SDK 利用者を新契約へ揃える。未移行の利用者を残して配備しない。

### 検証と作業記録

Anatomia plan (authentication / authorization / web-frontend) と Augur security plan を実装前に確認した。
Augur の一般的な「log-only へ戻す」提案は、neco の互換なし・fail-closed 決定に反するため採らない。
既存の S256 比較を共通 crypto module へ移して再利用し、依存パッケージは追加しない。
Actio の Cr 既存97件と近似タスクの本文を照合し、本変更と同一の仕事が無いことを確認した。
neco の実装・完了指示に対して公式 taskflow API で
`actio:e0acdef1-32ef-40a8-bc38-be2250bed9cb` を登録し、task-links 正本 GET で
同じ指示への関連と `in_progress/current` を確認した。本文・状態は Actio が正本とする。
単体・統合・起動テストは session では実行せず、境界・再利用・並行・失効・同意のテストを Revisor に渡す。

### 審査と反映を分ける境界

Cr の本差分は server / frontend / Composite SDK / native-composite の新契約をまとめて審査する。
Cr PR は先に merge してよいが、この時点の deploy は行わない。旧交換口・refresh 互換は無いため、
未移行サービスが残る環境へ反映するとログイン・下流委譲が停止する。
Co / GLAB の保存済み差分、GLAB の残る明示経路分類・大容量 upload、必要な target の delegation
受入、他 consumer の PKCE / kiosk / native 対応と管理者設定は別の依存 PR で揃える。
許可照会・ローカル ACL・本文 digest の契約を省略して移行済みとはしない。
審査通知・委託検証、管理者設定、順序を守った反映と利用先での確認が全て成立するまで、依頼全体を完了にしない。

提出前の静的確認では server / frontend / Composite / native-composite の各 `tsc --noEmit` と、
本差分の backend 契約テストの strict 型検査が通った。実行テストの成功は意味しない。
frontend テストを backend の汎用 CLI 設定へ一括投入すると frontend 固有の alias / Vite ambient と
既存の react-test-renderer 型宣言が不足するため、その一括検査の成功は主張しない。
UI ライフサイクル・正当な登録/ログインと全拒否境界を含む実行検証は Revisor へ委託する。

Revisor #3627 の scratch 準備は `bootstrap.mjs --server-only` と server の dev 依存復元であり、
frontend/SDK の node_modules は準備しない。SDK/UI の source alias に必要な実 WebAuthn package は
server の test devDependency として、既存 frontend lock と同じ `@simplewebauthn/browser` 13.3.0 / SSRI を
明示する。Vitest の source alias もその server 所有の実体に揃え、手元の SDK junction や mock で
準備不足を隠さない。MIT、追加の間接依存・導入 hook は無い。frontend 本番の依存・dedupe は変更しない。
同意 caps の期待値も、新契約の `serviceOperations: []` を含む正本の宣言モデルに合わせる。
保存された失敗ログは末尾だけなので、把握した失敗だけで全失敗を網羅したとは扱わず、再審査結果で確認する。
