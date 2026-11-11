# feature: V.O.B の Discord 発行トークンによる登録 (SPEC-VOB-DISCORD-REGISTRATION)

決定: neco 2026-11-06〜11-10。関連: [venue-network-registration.md](venue-network-registration.md) (会場限定の登録)。

## 0. 決定事項

| 論点 | 決定 |
|---|---|
| 組織 | AWS 本番 Cernere に **V.O.B** 組織を作る。GLab とは別組織 |
| 公開範囲 | V.O.B は広域 Web から登録する (会場 LAN の確認はしない) |
| 登録の入口 | V.O.B の Discord サーバーで **スラッシュコマンド** を打つと、Cernere 登録用の一回限りのリンクが本人だけに返る |
| 発行対象 | **サーバー参加者なら誰でも** |
| なりすまし | Discord の ID からサーバーの参加記録を確かめてブロックする |
| GLab との共有 | V.O.B から GLab へ一部だけ共有する。GLab が見られるのは V.O.B での表示名・V.O.B 所属・Discord 名だけ。逆方向は共有しない |

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
 5. 30 分有効・一回限りのトークンを発行 (DB にはハッシュ)。Discord ID と参加日時に束縛
 6. ephemeral (本人だけに見える) 応答でリンク {FRONTEND_URL}/start?vob=<token> を返す
   ▼
[端末]  リンクを開く → 名前 → パスキー作成 → signup-finish { vobToken }
   ▼
[Cernere signup]
 - ceremony 消費前: トークンが有効か確認し、もう一度サーバー参加を確かめる (抜けていたら 422)
 - user 作成と同じトランザクションで: トークンを条件付き消費、users.discord_id に自動連携
   (別アカウントに連携済みなら unique 制約で 422)、access_status = active、
   registration_origin = discord_vob、V.O.B 組織の member、access_decisions に自動許可を記録
```

- 一人一回: トークンは一回限り、Discord ID は users.discord_id の unique で 1 アカウントに限る。
- 会場確認 (`venueChallengeId`)・引き継ぎ (`federation`) とは同時に指定できない (400)。
- Discord の応答文は mention を発火させない (`allowed_mentions: { parse: [] }`)。

## 2. トークン

- 形式: 32 バイト乱数の base64url。DB には SHA-256 (`token_hash`) だけを保存する。
- 状態: 期限内・未消費のものだけ使える。消費済み・期限切れ・未知はすべて `vob_token_invalid` (422)。
- 同じ Discord ID で新しく発行すると、その ID の未消費トークンは失効させる (最後の 1 本だけ有効)。
- 期限から 1 日で回収する。

## 3. データ (migration 081)

- `vob_registration_tokens`: `id uuid PK`, `token_hash text unique`, `discord_user_id text`, `discord_username text`,
  `guild_joined_at timestamptz`, `organization_id uuid`, `expires_at`, `consumed_at`, `consumed_by_user_id uuid`,
  `revoked_at`, `created_at`。
- `users.registration_origin` に値 `discord_vob` を足す (列は既存)。`users.registration_place_id` に V.O.B 組織 ID。

## 4. 設定 (Vault: cernere)

| キー | 内容 |
|---|---|
| `CERNERE_VOB_DISCORD_PUBLIC_KEY` | Discord アプリの公開鍵 (hex)。interaction の署名検証 |
| `CERNERE_VOB_DISCORD_APPLICATION_ID` | Discord アプリ ID (コマンド登録スクリプト用) |
| `CERNERE_VOB_DISCORD_BOT_TOKEN` | サーバー参加の確認に使う Bot のトークン |
| `CERNERE_VOB_DISCORD_GUILD_ID` | V.O.B の Discord サーバー ID |
| `CERNERE_VOB_ORGANIZATION_ID` | Cernere の V.O.B 組織 (organizations.id、UUID) |

どれかが欠けたら機能は無効 (interaction は 503、signup の `vobToken` は 422)。

## 5. API

| 口 | 認可 | 結果 |
|---|---|---|
| `POST /api/discord/vob/interactions` | Discord 署名 | PING → `{type:1}`、`/register` → ephemeral のリンクまたは理由 |
| `signup-finish` / `composite-signup-finish` に `vobToken?` | 既存 | §1 |
| `GET /api/vob/shared-members` | project token + `vob-roster:read` | V.O.B 組織のメンバー `{ userId, displayName, affiliation: "V.O.B", discordUsername }` だけ |

GLab の Cernere project の `service_scopes` に `vob-roster:read` を宣言して使う。顔・メール・プロフィールなど他の情報は返さない。

## 6. 管理者の審査

許可待ち一覧に `discord_vob` を「V.O.B (Discord) から登録 (自動許可)」と出し、Discord ID とサーバー参加日時を添える。
怪しい利用者は一覧から停止できる (既存の lock)。

## 7. 人にお願いすること

1. Discord Developer Portal で V.O.B 用のアプリ (Bot) を作り、V.O.B サーバーへ招待する。
   Bot に **Server Members Intent** を有効にする (メンバー参照に必要)。
2. Interactions Endpoint URL に `https://<本番 Cernere>/api/discord/vob/interactions` を入れる。
3. §4 の値を Excubitor の Vault (cernere) に登録する。
4. Cernere に V.O.B 組織を作り、その ID を `CERNERE_VOB_ORGANIZATION_ID` に入れる。
5. `node scripts/register-vob-discord-command.mjs` でスラッシュコマンドを V.O.B サーバーに登録する。
6. Cernere を再起動する。

## 8. 脅威

| 脅威 | 対策 |
|---|---|
| Discord ID を偽った interaction | Ed25519 署名検証。タイムスタンプ 5 分以内 |
| サーバー外の人がリンクを入手 | 30 分・一回限り・Discord ID 束縛。完了時にもサーバー参加を再確認 |
| 同じ人が複数アカウント | トークン一回限り + discord_id unique + 連携済み ID には発行しない |
| 抜けた人がリンクを使う | 完了時の再確認で 422 |

## 9. 実装 (Cernere)

| 責務 | 置き場所 |
|---|---|
| 設定 | `server/src/vob/vob-config.ts` |
| 署名検証 | `server/src/vob/discord-signature.ts` |
| サーバー参加の確認 | `server/src/vob/discord-guild.ts` |
| トークンの状態判定 (純粋) | `server/src/vob/vob-token-state.ts` |
| トークンの発行・読み出し・消費・回収 | `server/src/vob/vob-token-store.ts` |
| interaction の処理 | `server/src/vob/vob-interactions.ts`、HTTP は `server/src/http/vob-routes.ts` |
| signup の分岐 | `server/src/vob/vob-registration-signup.ts` |
| GLab への共有 | `server/src/vob/vob-shared-members.ts` |
| コマンド登録 | `scripts/register-vob-discord-command.mjs` |
| 登録画面 | `frontend/src/pages/onboarding/StartPage.tsx` (`?vob=` のとき会場確認を出さない) |
