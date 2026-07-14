# 各サービスを Cernere に登録するための設定

外部サービス (Schedula / Memoria / Actio / Imperativus 等) を Cernere に認証連携させるための設定を扱う。サーバ認証 (project credentials)、ユーザ×project トークン (`/api/auth/project-token`)、サービス間直接通信 (peer relay) の 3 軸。

関連: [../auth-flows.md](../auth-flows.md) (経路 5 種)・[../project-management.md](../project-management.md) (`managed_projects`)・[../peer-relay.md](../peer-relay.md)・[../../docs/integration_guide.md](../../docs/integration_guide.md) (サービス側実装)。

## 1. プロジェクト登録 (`managed_projects`)

サービスは `managed_projects` テーブルに 1 行登録する。スキーマは `migrations/010_managed_projects.sql`:

| カラム | 説明 |
|---|---|
| `key` (PK) | 英数字のみのユニークキー (例: `schedula`、`memoria`)。project-token の `projectKey`、relay の参照キー |
| `name` | 表示名 |
| `client_id` (UNIQUE) | サーバ認証 (project_credentials) の ID |
| `client_secret_hash` | bcrypt ハッシュ (平文は保存しない) |
| `schema_definition` (JSONB) | ユーザーデータの動的テーブル定義 ([../project-management.md](../project-management.md)) |
| `is_active` | 論理削除フラグ (false で全認証拒否) |

登録は admin による DB 直挿入、またはシード migration (例: `017_memoria_managed_project_seed.sql` / `020_legatus_managed_project_seed.sql`) で行う。`client_secret` は bcrypt ハッシュにして `client_secret_hash` に格納する。

シード migration が作った project の初回secret取得、またはsecret紛失時の再発行は、
対象DBの `DATABASE_URL` を設定して `server/` から次を実行する。旧secretは即時無効になり、
新しい平文secretはこの出力で一度だけ表示される。

```bash
npx tsx scripts/rotate-project-secret.ts --project glab
```

ログイン済みsystem adminはWSの `managed_project.rotate_secret { key }` でも同じ操作を行える。

### Excubitorによる起動時credential

Excubitor自身は一度だけproject secretを発行し、Cernere用Infisical projectへ
`EXCUBITOR_CERNERE_CLIENT_ID` / `EXCUBITOR_CERNERE_CLIENT_SECRET`として保存する。
以後、GLAB起動時はExが次の認証endpointを呼び、GLAB用credentialを毎回rotateする。

```http
POST /api/auth/project-launch-credential
Content-Type: application/json

{
  "client_id": "<Excubitor client id>",
  "client_secret": "<Excubitor client secret>",
  "target_project_key": "glab",
  "launch_id": "<UUID>",
  "target_client_secret": "<Exが起動ごとに生成した32文字以上のsecret>"
}
```

Cernereは`project_credential_issuers`でissuerをfail-closedに検査する。Exから受け取った
平文はレスポンスへ返さず、現行認証用と履歴照合用のbcrypt hashだけを永続化する。同じactiveな
`launch_id + secret`の再送は冪等応答し、異なるsecretなら409を返す。新しい起動では
`credential_generation`を増やし、旧secretだけでなく旧JWTと旧WebSocket操作も無効化する。

> ExがGLABへ注入する`client_secret`は起動単位であり、Ex自身のissuer credentialとは別物。issuer credentialはGLABへ継承しない。エンドユーザ操作のためのtokenは下記project-tokenを使う。

## 2. サーバ認証 → project token (HS256)

サービスのサーバが自分を認証する経路 ([../auth-flows.md](../auth-flows.md) §3):

```
POST /api/auth/login
  { "grant_type":"project_credentials", "client_id":"...", "client_secret":"..." }
→ { "tokenType":"project", "accessToken":<HS256>, "expiresIn":3600, "project":{...} }
```

取得した project token で WS 接続:

```
GET /ws/project?token=<projectToken>
→ { "type":"connected", connection_id, project_key, client_id }
```

WS 上では `module_request` で `managed_project.*` / `managed_relay.*` / `auth.*` を呼ぶ。project token は `JWT_SECRET` 共有の **HS256** (RS256/JWKS は撤去済み。[../peer-relay.md](../peer-relay.md))。レートリミット `project_login:<client_id>` 10/5min。

## 3. ユーザ × project トークン (`/api/auth/project-token`)

サービスが「**ログイン中ユーザ**が、ある project に向けて使う」短命トークンを per-user × per-project で都度発行する経路 (`server/src/http/auth-handler.ts` の `projectUserToken`)。

```
POST /api/auth/project-token
  Authorization: Bearer <user accessToken>
  { "project_key":"memoria", "hub_url":"https://hub.example.com" }   # project_id でも可 (後方互換)
→ { "tokenType":"user_for_project", "accessToken":..., "expiresIn":900, "projectKey":..., "userId":..., "displayName":..., "audience":..., "alg":"EdDSA" }
```

- 署名は **PASETO Ed25519 必須** (`alg:"EdDSA"`、`aud=hub_url`、TTL 15 分)。鍵設定は [paseto-keys.md](paseto-keys.md)。
- **`hub_url` は必須**。`aud` を欠くと「service A 向け token を service B が受理する」横断偽造 (confused deputy) を許すため、未指定は `400` で拒否する (fail-closed)。
- **HS256 フォールバックは撤去済み** (旧: `hub_url` 無し or PASETO 無効時にマスタ `JWT_SECRET` で署名・`aud` 無し)。マスタ署名鍵の leaf 横展開と `aud` 無し横断偽造を許すセキュリティ欠陥だったため。PASETO 鍵未設定のサーバでは本経路は `500` で拒否する (暗黙降格しない、RULE §7.1)。
- レートリミット `project_user_token:<userId>:<projectKey>` 60/60s。`managed_projects` に `is_active=true` で存在しない `project_key` は拒否。

> **注 (§2 との切り分け)**: サーバ自己認証の project token (§2、`grant_type=project_credentials` → `/ws/project`) は引き続き HS256 (`JWT_SECRET` 共有) を**正当に**使う。撤去したのは本 §3 の user×project フォールバックのみ。

> **設計意図 — secret は per-user / memory-only**: 呼び出し元 (Memoria local backend 等) は**自分用の long-lived secret を持たない**。ログイン中ユーザの user JWT を借りて project ごとの短命トークンを都度発行し、**呼び出し元 process の memory のみ**に保持する (disk / Infisical に残さない、user/AI も値を見ない)。共有 long-lived な service_credential を配るのは NG。

## 4. OAuth プロバイダ登録 (任意)

エンドユーザの GitHub / Google ログインを使う場合のみ。`server/src/config.ts` が読むキー:

| プロバイダ | キー |
|---|---|
| GitHub | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_REDIRECT_URI` (既定 `…/auth/github/callback`) |
| Google | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` (既定 `…/auth/google/callback`) |

コールバックは `GET /auth/<provider>/callback`。`state` プリフィクスで通常 / `composite:` (埋め込み) / `link:` (アカウント連携) を切り替える ([../auth-flows.md](../auth-flows.md) §2)。redirect URI は各プロバイダのアプリ設定と一致させること。

## 5. サービス間直接通信 (peer relay)

サービス A ↔ B が Cernere を**データ経路に挟まず**直接 WS で呼び合う場合 ([../peer-relay.md](../peer-relay.md))。Cernere は認証局としてのみ介在する。

1. admin が `relay_pairs` (A↔B) を登録 (`migrations/015_relay_pairs.sql`、例: `018_memoria_imperativus_relay_pair.sql`)。`bidirectional` で双方向可否。
2. 各サービスは project token で `/ws/project` 接続後、`managed_relay.register_endpoint` で自分の SA WS URL を登録。
3. A→B 呼び出し時、A は `managed_relay.request_peer` で B の URL + challenge を取得 → B に直接接続。B は受けた token を `managed_project.verify_token` で、challenge を `managed_relay.verify_challenge` で Cernere に round-trip 検証する。
4. B 側 PeerAdapter の `accept` リストに A の projectKey と command が含まれれば開通 (fail-closed)。

実装は `@ludiars/cernere-service-adapter` の `PeerAdapter`。

## サービス側 (受け取る側) の検証

- **PASETO user×project token (§3)**: `/.well-known/cernere-public-key` から公開鍵を fetch (6h ごと等) してローカル検証。`aud` (= 自分の URL) と `kind="user_for_project"` を必ず照合する。署名鍵を共有しないので leaf 漏洩でも偽造能力は漏れない。
- **HS256 project token (§2)**: サーバ自己認証の project token (`/ws/project`) は `JWT_SECRET` を共有してローカル HMAC 検証する経路が残る (`@cernere/id-cache` 等、[../../docs/integration_guide.md](../../docs/integration_guide.md))。これは §3 の user×project token とは別物。user×project token を HS256 で受ける旧経路は撤去済み。

> Cernere は実質 `/auth` 系しか開かない。`/oauth/*` や `/ws/service` は**存在しない**。サービス WS は `/ws/project`、公開鍵は `/.well-known/cernere-public-key`。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `project '<key>' not found or inactive` | `managed_projects` 未登録 or `is_active=false`。シード migration / DB を確認。 |
| project-token が `400 hub_url is required` | §3 は `hub_url` 必須 (aud 用)。呼び出し元は参照先サービスの baseUrl を必ず渡す。 |
| project-token が `500 ... PASETO keys not configured` | サーバに PASETO 鍵が未設定。[paseto-keys.md](paseto-keys.md) で `CERNERE_PASETO_SECRET_KEY`/`_PUBLIC_KEY` を設定する (HS256 へ暗黙降格はしない)。 |
| WS `/ws/project` が 401 | project token が無効 / 期限切れ。`project_credentials` で再取得。 |
| peer relay が `deny("not in accept list")` | 受け側 PeerAdapter の `accept` に呼び出し元 projectKey / command が無い。 |
| OAuth コールバックで CSRF エラー | `state` と Cookie 不一致 / redirect URI 不一致。プロバイダ側設定と `*_REDIRECT_URI` を揃える。 |
