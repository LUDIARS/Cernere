# PASETO 署名鍵 (project-token) の生成・設定

「ログイン中ユーザ × ある project (Memoria Hub 等)」向けに発行する **project-token** を Ed25519 公開鍵署名 (PASETO v4) で署名するための鍵設定を扱う。実装は `server/src/auth/paseto.ts`、鍵生成は `scripts/generate-paseto-keypair.ts`、公開は `GET /.well-known/cernere-public-key` (`server/src/app.ts`)。背景は Cernere Issue #91。

## なぜ PASETO (Ed25519) か

HS256 共有 secret 時代は「Hub が secret を持つ = Hub 漏洩で偽造能力も漏れる」状態だった。PASETO v4 では:

- 署名鍵 (secret) は **Cernere だけ**が持つ。
- サービス側 (Hub) は **public key のみ**を `/.well-known/cernere-public-key` から fetch して**ローカル検証**する (偽造不可)。

> 鍵が未設定なら PASETO は無効化され、project-token は旧 **HS256** 経路 (`JWT_SECRET` 署名) で発行される (`loadKeys()` が undefined を返し legacy mode)。移行期間中の互換動作。

## 設定キー

`server/src/auth/paseto.ts` の `loadKeys()` が読むキー。`config.ts` ではなくこのモジュールが直接 `process.env` を読む。

| キー | 必須 | 形式 | 用途 |
|---|---|---|---|
| `CERNERE_PASETO_SECRET_KEY` | 有効化するなら必須 | base64 (32 byte seed、または 64 byte = seed‖public) | 署名鍵 (Cernere のみ保持) |
| `CERNERE_PASETO_PUBLIC_KEY` | 同上 | base64 (raw 32 byte) | 現行公開鍵 (公開・検証用) |
| `CERNERE_PASETO_KID` | 任意 (既定 `v1`) | 文字列 | 現行鍵の key id |
| `CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS` | 任意 | `kid:base64,kid:base64,...` | ローテーション移行中の検証専用旧公開鍵 |

`CERNERE_PASETO_SECRET_KEY` / `_PUBLIC_KEY` の**両方**が揃って初めて有効化される。片方だけだと無効で起動時に warn が出る。無効のままだと user×project token 経路 (`/api/auth/project-token`) は `500` で拒否される (旧 HS256 フォールバックは撤去済み。暗黙降格しない)。

## 手順

### 1. 鍵ペアを生成

```bash
npx tsx scripts/generate-paseto-keypair.ts
```

出力例 (そのまま env / Infisical に貼れる形式):

```
CERNERE_PASETO_SECRET_KEY=<base64 of 32-byte seed>
CERNERE_PASETO_PUBLIC_KEY=<base64 of 32-byte raw>
CERNERE_PASETO_KID=v1
```

### 2. Infisical / env に登録

`CERNERE_PASETO_SECRET_KEY` は Cernere の secret store にのみ置く。Infisical を使うなら:

```bash
npm run env:set CERNERE_PASETO_SECRET_KEY <base64>
npm run env:set CERNERE_PASETO_PUBLIC_KEY <base64>
npm run env:set CERNERE_PASETO_KID v1
```

(これらは `env-cli.config.ts` の `infraKeys` には含まれないが、`ensureEnv()` が同 workspace の全 secret を注入するため反映される。詳細は [infisical-secrets.md](infisical-secrets.md)。)

### 3. 起動確認

Cernere 起動時、有効化されていれば次のログが出る:

```
[paseto] enabled (signing kid=v1)
```

未設定なら:

```
[paseto] CERNERE_PASETO_SECRET_KEY/_PUBLIC_KEY not set — falling back to HS256 only
```

公開鍵は `GET /.well-known/cernere-public-key` で確認できる (`{ keys: [{ kid, alg:"EdDSA", public_key, current }] }`、`cache-control: max-age=600`)。

## project-token がどう署名されるか

`POST /api/auth/project-token` (`server/src/http/auth-handler.ts`) は:

- `hub_url` が渡され**かつ** PASETO 有効 → Ed25519 で署名 (`alg: "EdDSA"`、`aud = hub_url`、TTL 15 分)。
- それ以外 (旧クライアント・`hub_url` 無し・PASETO 無効) → HS256 にフォールバック (TTL 3600 秒)。

claims は `sub`(userId) / `projectKey` / `role` / `displayName` / `kind="user_for_project"` / `aud` / `iat` / `exp` / `jti`。`aud` は受け取る service の URL で、検証時に必須照合される (confused-deputy 防止)。発行 API の詳細は [service-registration.md](service-registration.md)。

## 鍵ローテーション手順

署名鍵は `_SECRET_KEY` / `_PUBLIC_KEY` / `_KID` の 1 組のみ。移行ウィンドウ中も旧 token を検証できるよう `_PREVIOUS_PUBLIC_KEYS` に旧公開鍵を並べる:

1. 新鍵ペアを生成し、**旧** public key を `CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS` に `oldkid:base64` で追記。
2. `_SECRET_KEY` / `_PUBLIC_KEY` / `_KID` を新鍵に差し替えて再起動 (新 token は新鍵で署名)。
3. 旧 token の TTL (15 分) 経過後、`_PREVIOUS_PUBLIC_KEYS` から旧公開鍵を削除。

旧公開鍵も `/.well-known/cernere-public-key` で公開されるため、サービス側は新旧どちらの token も検証できる。

## 注意点 (実装の罠)

- **raw 32 byte seed を `V4.sign` に直接渡すと失敗する**: paseto v3.x は raw Buffer を public key と誤判定する。`paseto.ts` は PKCS8 ASN.1 prefix (`302e020100300506032b657004220420`) を seed の前に連結し `crypto.createPrivateKey({ format:"der", type:"pkcs8" })` で **KeyObject 化**してから署名する (`seedToPrivateKey()`)。鍵を base64 で渡すだけで良く、利用者側でこの変換を意識する必要はないが、鍵フォーマットを変えるときはこの前提を壊さないこと。
- **`iat` / `exp` は ISO 8601 文字列**: paseto v3 規約では Unix epoch number を入れると検証側で `payload.exp must be a string` で reject される。`signProjectToken()` は `new Date(...).toISOString()` で文字列化している。
- **secret 鍵長は 32 (seed) か 64 (seed‖public)**、public は 32 byte 固定。これ以外は起動時 `PASETO key load failed: ... length=...` で例外。
- **`_PREVIOUS_PUBLIC_KEYS` の kid 重複は不可** (現行 kid と被ると起動失敗)。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `[paseto] ... falling back to HS256 only` | `_SECRET_KEY` か `_PUBLIC_KEY` のどちらかが未設定。両方セットする。 |
| `PASETO key load failed: ... length=N` | base64 デコード後の鍵長が不正。`generate-paseto-keypair.ts` の出力をそのまま使う。 |
| サービス側で aud 不一致エラー | project-token 発行時の `hub_url` と検証時の `expectedAudience` が不一致。両者を service の URL で揃える。 |
| `duplicate kid "..."` で起動失敗 | `_PREVIOUS_PUBLIC_KEYS` に現行 `_KID` と同じ kid を入れた。旧 kid を別名にする。 |
