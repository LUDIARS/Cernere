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
