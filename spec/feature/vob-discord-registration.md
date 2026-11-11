# feature: V.O.B の Discord 発行トークンによる登録 (SPEC-VOB-DISCORD-REGISTRATION)

決定: neco 2026-11-06〜11-11 (11-11: 管理画面からの Bot 設定・管理者チャンネル通知・参加 1 週間以内は許可制)。
関連: [venue-network-registration.md](venue-network-registration.md) (会場限定の登録)。

## 0. 決定事項

| 論点 | 決定 |
|---|---|
| 組織 | AWS 本番 Cernere に **V.O.B** 組織を作る。GLab とは別組織 |
| 公開範囲 | V.O.B は広域 Web から登録する (会場 LAN の確認はしない) |
| 登録の入口 | V.O.B の Discord サーバーで **スラッシュコマンド** を打つと、Cernere 登録用の一回限りのリンクが本人だけに返る |
| 発行対象 | **サーバー参加者なら誰でも** |
| なりすまし | Discord の ID からサーバーの参加記録を確かめてブロックする |
| GLab との共有 | V.O.B から GLab へ一部だけ共有する。GLab が見られるのは V.O.B での表示名・V.O.B 所属・Discord 名だけ。逆方向は共有しない |
| Bot の設定 | Cernere の管理画面 (`/admin/discord-bot`、system admin) から設定する。正本は DB の 1 行 |
| 管理者への通知 | `/register` が打たれたら、結果に関わらず管理者だけが見えるチャンネルへ知らせる |
| 日が浅い参加者 | Discord サーバーに参加してから **1 週間 (既定 7 日、画面で 0〜90 日)** 以内の人は、登録後に管理者の許可が要る |

## 1. フロー

```
[V.O.B Discord]  /register (日本語名 /登録)
   │  Discord → POST /api/discord/vob/interactions (Ed25519 署名付き)
   ▼
[Cernere]
 1. 署名検証 (X-Signature-Ed25519 / X-Signature-Timestamp、アプリの公開鍵)。不一致は 401
 2. guild_id が V.O.B サーバーか
 3. その Discord ID が既に Cernere アカウントに連携済みなら発行しない
 4. Bot で GET /guilds/{guild}/members/{user} → 参加していなければ発行しない。参加日時を記録
 5. 参加から approval_window_days 日未満 (または参加日時が不明) なら requires_approval = true
 6. 30 分有効・一回限りのトークンを発行 (DB にはハッシュ)。Discord ID・参加日時・requires_approval に束縛
 7. ephemeral (本人だけに見える) 応答でリンク {FRONTEND_URL}/start?vob=<token> を返す
    (requires_approval なら「登録後、管理者の許可が出るまで使えない」旨を添える)
 8. 管理者チャンネルへ通知 (発行 / 許可が要る / 未参加 / 連携済み)。3 秒期限を守るため待たない
   ▼
[端末]  リンクを開く → 名前 → パスキー作成 → signup-finish { vobToken }
   ▼
[Cernere signup]
 - ceremony 消費前: 機能が有効か・トークンが有効か確認し、もう一度サーバー参加を確かめる (だめなら 422)
 - user 作成と同じトランザクションで: トークンを条件付き消費、users.discord_id に自動連携
   (別アカウントに連携済みなら unique 制約で 422)、registration_origin = discord_vob、
   registration_place_id = V.O.B 組織
   - requires_approval = false: access_status = active、V.O.B 組織の member、access_decisions に自動許可を記録
   - requires_approval = true:  access_status = pending のまま。組織には入れず、自動許可も記録しない。
     確定後に管理者チャンネルへ「許可待ちになりました」と通知 (待たない)
```

- 一人一回: トークンは一回限り、Discord ID は users.discord_id の unique で 1 アカウントに限る。
- 会場確認 (`venueChallengeId`)・引き継ぎ (`federation`) とは同時に指定できない (400)。
- Discord の応答文・管理者チャンネルの通知は mention を発火させない (`allowed_mentions: { parse: [] }`)。
  通知に載せる Discord のユーザ名は、改行・制御文字・ゼロ幅文字を落とし、`@` と markdown 記号を無効化してから入れる。
- 管理者チャンネルの通知は best-effort。失敗はサーバーのログ (`vob.admin_notice.failed`) だけで、本人への応答は変えない。
  DM や別サーバーからのコマンドは通知しない。管理者チャンネルが未設定なら送らない。
- 認証ログ: 自動許可は `user.vob_registration.joined`、許可待ちは `user.vob_registration.pending`。

## 2. トークン

- 形式: 32 バイト乱数の base64url。DB には SHA-256 (`token_hash`) だけを保存する。
- 状態: 期限内・未消費のものだけ使える。消費済み・期限切れ・未知はすべて `vob_token_invalid` (422)。
- 同じ Discord ID で新しく発行すると、その ID の未消費トークンは失効させる (最後の 1 本だけ有効)。
- 期限から 1 日で回収する。

## 3. データ (migration 081・083)

- `vob_registration_tokens`: `id uuid PK`, `token_hash text unique`, `discord_user_id text`, `discord_username text`,
  `guild_joined_at timestamptz`, `organization_id uuid`, `expires_at`, `consumed_at`, `consumed_by_user_id uuid`,
  `revoked_at`, `created_at`。083 で `requires_approval boolean NOT NULL DEFAULT false` を足す。
- `users.registration_origin` に値 `discord_vob` を足す (列は既存)。`users.registration_place_id` に V.O.B 組織 ID。
- 083: `discord_bot_settings` (id = 1 の 1 行だけ): `enabled`, `application_id`, `public_key_hex`, `bot_token_enc`,
  `guild_id`, `organization_id uuid`, `admin_channel_id`, `approval_window_days int default 7 (0..90)`,
  `updated_by_user_id`, `updated_at`。

## 4. 設定 (DB + 管理画面)

正本は `discord_bot_settings` の 1 行だけ。管理画面 `/admin/discord-bot` (system admin) から WS module `discord_bot` で読み書きする。
環境変数 (旧 `CERNERE_VOB_*`) からは読まない (秘密を env と DB の 2 系統にしない)。

| 項目 | 内容 |
|---|---|
| 有効 | オフなら機能は無効 |
| Application ID | Discord アプリ ID (snowflake)。コマンド登録に使う |
| Public Key | Discord アプリの公開鍵 (64 桁 hex)。interaction の署名検証 |
| Bot トークン | サーバー参加の確認・通知・コマンド登録に使う。secret-box (AES-256-GCM, `CERNERE_SECRET_KEY`) で暗号化して保存し、画面には「保存済みか」だけ返す。空のまま保存すると既存を残す |
| サーバー ID | V.O.B の Discord サーバー (guild) ID |
| 組織 ID | Cernere の V.O.B 組織 (organizations.id、UUID) |
| 管理者チャンネル ID | 管理者だけが見えるチャンネル。空なら通知しない |
| 許可が要る日数 | サーバー参加からこの日数未満の人は許可制 (既定 7、0 で無効、最大 90) |

- 無効・欠け・形式違い・Bot トークンを復号できない、のどれかなら機能は無効 (interaction は 503、signup の `vobToken` は 422)。
- 有効にして保存するときは、必須項目 (Bot トークンは新しく入れた値か保存済みの値) が揃っていなければ 400。無効のままなら途中まで保存できる。
- 保存 (`discord_bot.update`) は fresh action proof (この端末のパスキー) が要る。resource は固定文字列 `settings`。
- 画面に Interactions Endpoint URL (`{CERNERE_PUBLIC_URL}/api/discord/vob/interactions`、フロントの URL ではない) と動作可能かを表示する。
- 登録リンクの戻り先は `FRONTEND_URL` (Bot の設定ではなくサービス全体の配置値)。

## 5. API

| 口 | 認可 | 結果 |
|---|---|---|
| `POST /api/discord/vob/interactions` | Discord 署名 | PING → `{type:1}`、`/register` → ephemeral のリンクまたは理由 |
| `signup-finish` / `composite-signup-finish` に `vobToken?` | 既存 | §1 |
| `GET /api/vob/shared-members` | project token + `vob-roster:read` | V.O.B 組織のメンバー `{ userId, displayName, affiliation: "V.O.B", discordUsername }` だけ |
| WS `discord_bot` `get` / `update` / `register_commands` | system admin (update は action proof) | §4。`register_commands` は保存済みの設定で `/register` (`/登録`) を guild に PUT 登録 (冪等) |

GLab の Cernere project の `service_scopes` に `vob-roster:read` を宣言して使う。顔・メール・プロフィールなど他の情報は返さない。

## 6. 管理者の審査

`discord_vob` は次の 2 つに分けて出し、Discord ID とサーバー参加日時を添える。

- 「V.O.B (Discord) から登録 (自動許可)」: 参加から日数が経っていた人。active・V.O.B 組織の member になっている。
- 「V.O.B (Discord) から登録 (サーバー参加 N 日以内のため許可待ち)」: pending の一覧に出る (N は現在の設定値)。
  管理者が許可すると、同じトランザクションで V.O.B 組織 (`registration_place_id`) に member として入る。拒否なら入らない。

怪しい利用者は一覧から停止できる (既存の lock)。

## 7. 人にお願いすること

1. Discord Developer Portal で V.O.B 用のアプリ (Bot) を作り、V.O.B サーバーへ招待する。
   Bot に **Server Members Intent** を有効にする (メンバー参照に必要)。
2. Cernere に V.O.B 組織を作る。管理者だけが見えるチャンネルを Discord サーバーに作り、Bot にそのチャンネルへの書き込み権限を与える。
3. Cernere の管理画面「Discord Bot」で §4 の値を入れて保存する (Vault ではなく画面。再起動は要らない)。
4. Discord Developer Portal の Interactions Endpoint URL に、画面に出る URL を入れる。
5. 画面の「スラッシュコマンドを登録」ボタンでコマンドを V.O.B サーバーに登録する。

## 8. 脅威

| 脅威 | 対策 |
|---|---|
| Discord ID を偽った interaction | Ed25519 署名検証。タイムスタンプ 5 分以内 |
| サーバー外の人がリンクを入手 | 30 分・一回限り・Discord ID 束縛。完了時にもサーバー参加を再確認 |
| 同じ人が複数アカウント | トークン一回限り + discord_id unique + 連携済み ID には発行しない |
| 抜けた人がリンクを使う | 完了時の再確認で 422 |
| 作りたてのアカウントでサーバーに入ってすぐ登録 | 参加 N 日以内は自動許可せず pending、管理者の許可で初めて組織に入る。参加日時不明も許可制 |
| 通知に載る他人の文字列で mention・偽の行を作る | `allowed_mentions: { parse: [] }` + ユーザ名の無害化 (改行・制御文字除去、`@`・markdown のエスケープ) |
| Bot トークンの漏えい | DB は暗号化保存、画面・WS 応答には返さない、操作ログはキー名でマスク |
| 設定の改ざん | system admin 限定 + `discord_bot.update` の action proof。`updated_by_user_id` と operation_logs に残す |

## 9. 実装 (Cernere)

| 責務 | 置き場所 |
|---|---|
| 設定の検証 (純粋) | `server/src/vob/vob-config.ts` |
| 設定の読み書き (DB、暗号化) | `server/src/vob/discord-bot-settings-store.ts` |
| 管理画面の WS コマンド | `server/src/vob/discord-bot-settings-command.ts` (`server/src/commands.ts` の `discord_bot`) |
| 参加日数による許可制の判定 (純粋) | `server/src/vob/approval-window.ts` |
| 管理者チャンネルへの通知 | `server/src/vob/discord-admin-notice.ts` |
| V.O.B 組織への参加 (自動許可時・管理者の許可時) | `server/src/vob/vob-organization-membership.ts` (許可は `server/src/auth/user-access.ts` の decideAccess から) |
| 署名検証 | `server/src/vob/discord-signature.ts` |
| サーバー参加の確認 | `server/src/vob/discord-guild.ts` |
| トークンの状態判定 (純粋) | `server/src/vob/vob-token-state.ts` |
| トークンの発行・読み出し・消費・回収 | `server/src/vob/vob-token-store.ts` |
| interaction の処理 | `server/src/vob/vob-interactions.ts`、HTTP は `server/src/http/vob-routes.ts` |
| signup の分岐 | `server/src/vob/vob-registration-signup.ts` |
| GLab への共有 | `server/src/vob/vob-shared-members.ts` |
| コマンド定義と登録 | `server/src/vob/discord-commands.ts` (旧 `scripts/register-vob-discord-command.mjs` は削除) |
| 管理画面 | `frontend/src/pages/admin/DiscordBotPage.tsx`、`frontend/src/lib/discord-bot-api.ts` |
| 登録画面 | `frontend/src/pages/onboarding/StartPage.tsx` (`?vob=` のとき会場確認を出さない) |
