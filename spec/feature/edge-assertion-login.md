# Edge Assertion Login (Cloudflare Access → Cernere バイパス認証)

**Status: Proposed** (2026-07-26)

Cloudflare Access (以下 CF Access) など **エッジで本人確認を済ませた IdP のアサーション**を
Cernere が検証し、Cernere セッションを発行する認証経路。エンドユーザは企業 SSO で
1 回ログインするだけで、Cernere での再ログインを求められない。

想定利用者は Corpus 派生の **企業用 Hub** (1 Hub = 1 社)。Hub の origin は
Cloudflare Tunnel 経由でのみ到達可能とし、CF Access がその前段で認証する。

> セットアップ手順は [`spec/setup/cf-access-bypass.md`](../setup/cf-access-bypass.md)。
> Cernere を **IdP 側** にする逆向きの構成は [`oidc-provider.md`](oidc-provider.md)
> (CF Access の login method に Cernere を登録する)。両者は排他ではなく、
> CF Access の上流 IdP が Cernere OIDC であっても本経路はそのまま成立する。

---

## 1. 位置づけ

[`interface/auth-flows.md`](../interface/auth-flows.md) の 5 経路に対する 6 番目。

| 経路 | 入力 | 出力 |
|---|---|---|
| edge assertion | 上流エッジの署名済みアサーション (CF Access JWT) | one-time `authCode` |

`authCode` 以降は composite と完全に同じ (`POST /api/auth/exchange` で
access/refresh に交換)。新しいトークン形式は増やさない。

---

## 2. 前提条件 (崩れると本経路は無効)

1. **Hub の origin は CF 経由でしか到達できないこと。** `cloudflared` トンネルのみで
   公開し、インバウンドポートを開けない。直接到達できると `Cf-Access-Jwt-Assertion`
   ヘッダを偽装するだけで任意ユーザに成りすませる。
2. `Cf-Access-Authenticated-User-Email` ヘッダは**信頼しない** (署名が無い)。
   常に JWT アサーションを検証する。
3. Cernere は **Hub の主張ではなく生アサーションを自分で検証**する。
   Hub が侵害されても任意の identity を鋳造できない。
4. Hub ↔ Cernere はサーバ間 (project credential + `/ws/project`)。この経路は CF を通さない。

---

## 3. フロー

```mermaid
sequenceDiagram
    autonumber
    participant U as 社員ブラウザ
    participant CF as Cloudflare Access
    participant H as 企業用 Hub (Corpus)
    participant CS as Cernere Server
    participant DB as PostgreSQL

    U->>CF: GET https://hub.example.com/
    CF->>U: 企業 IdP でログイン (SAML / OIDC / OTP)
    CF->>H: リクエスト転送<br/>Header: Cf-Access-Jwt-Assertion
    H->>H: JWKS でヘッダ検証 (fail fast)
    alt Hub の認証 Cookie 無し / 失効
        H->>CS: WS module_request<br/>{ module:"auth", action:"edge_assertion",<br/>  payload:{ assertion } }
        CS->>CS: 独立検証 (§4) → ID 解決 (§5)
        CS->>DB: edge_identities UPSERT / users 自動作成
        CS->>CS: issueAuthCode() + ensureUserProjectRow()
        CS-->>H: { authCode }
        H->>CS: POST /api/auth/exchange { code }
        CS-->>H: { accessToken, refreshToken, user }
        H->>U: Set-Cookie (HttpOnly, Hub origin)
    end
    U->>H: 以降は既存 Corpus 認証と同一
```

Hub にログイン UI は存在しない。CF Access を抜けた時点で認証済みになる。

---

## 4. WS コマンドと検証

REST エンドポイントは生やさない。**project WS (`/ws/project`) 限定**とし、
呼び出せるのは登録済みプロジェクトだけに閉じる。

```jsonc
// request
{ "type": "module_request", "module": "auth", "action": "edge_assertion",
  "payload": {
    "assertion": "<CF Access JWT>",
    "identity": { /* 任意 — Hub が get-identity で取った補完属性 (§5.3)。署名が無いので表示名等にしか使わない */ },
    "fingerprint": { /* 任意 */ },
    "ip": "..."
  } }

// response
{ "type": "module_response", "module": "auth", "action": "edge_assertion",
  "payload": { "authCode": "<uuid>" } }
```

projectKey は WS セッションから自動付与される (composite の `auth.login` と同じ扱い)。
これにより [`user-project-row.md`](user-project-row.md) の `ensureUserProjectRow()` が効く。

### 検証手順 (fail-closed。 すべて通って初めて成功)

| # | 検査 | 失敗時 `reason` |
|---|---|---|
| 1 | 呼び出し元 projectKey に有効な `edge_idp_bindings` 行があるか | `no_binding` |
| 2 | JWT header の `kid` で team JWKS から公開鍵を引く (§6) | `signature` |
| 3 | 署名検証。 alg は `RS256` のみ許可 (`none` / HS 系は拒否) | `signature` |
| 4 | `iss` が登録 team domain と完全一致 | `issuer` |
| 5 | `aud` に登録済み Application AUD tag を含む (完全一致) | `aud` |
| 6 | `exp` / `iat` / `nbf` (許容スキュー 60 秒) | `expired` |
| 7 | `common_name` を持つ / `sub` が空 = **サービストークン** は拒否 | `service_token` |
| 8 | `email` のドメインが `allowed_email_domains` に含まれる | `domain` |
| 9 | rate limit `edge_assertion:<projectKey>:<sub>` 5 分 30 回 | `rate_limited` |
| 10 | ID 解決 / プロビジョニング可否 (§5) | `not_provisioned` |

成功・失敗とも `operation_logs` に記録する。

**リプレイについて**: CF アサーションはセッション有効期間中は同じ値が使い回される
(one-time ではない)。したがって本経路の防御線は「その `aud` の JWT を鋳造できるのは
CF だけ」+「提示できるのは project 認証済みの Hub だけ」の 2 点であり、
§2-1 (origin が CF 経由限定) が実質的な前提条件になる。

---

## 5. ID 解決とプロビジョニング

### 5.1 何を紐付けキーにするか

**CF の `sub` はキーに使わない。** CF のドキュメント上 `sub` は
「アカウント内で email ごとに一意」であり、ユーザを削除して再追加した場合や
別組織にログインした場合に **値が変わる**。永続キーとしての保証が無い。

| 優先 | キー | 出所 | 備考 |
|---|---|---|---|
| 1 | **上流 IdP の subject** | custom OIDC claim (Google なら `sub`、Entra なら `oid`) | 企業運用の推奨。 IdP 上で不変 |
| 2 | email | JWT の `email` claim | claim 未設定時のフォールバック。 メール変更で別人になる |
| — | CF の `sub` | JWT の `sub` claim | **監査・セッション相関のみ**。 キーにしない |

上流 IdP の subject を得るには、CF の IdP 設定 (Optional configurations) で
その claim を **custom OIDC claim として明示追加**する必要がある
(`spec/setup/cf-access-bypass.md` §1.4)。 どの claim 名を主キーとするかは
binding の `subject_claim` で指定する。

### 5.2 解決フロー

```mermaid
flowchart TD
    A([検証済みアサーション]) --> S[subject を決める<br/>custom[subject_claim] → 無ければ email]
    S --> B{edge_identities に<br/>subject の行あり?}
    B -- Yes --> Z([そのユーザ<br/>last_seen_at / cf_sub 更新])
    B -- No --> C{users.email に<br/>一致あり?}
    C -- Yes --> D{provisioning}
    D -- auto / link_only --> E[リンク<br/>edge_identities INSERT] --> Z
    D -- invite_only --> F{招待済み?}
    F -- Yes --> E
    F -- No --> R([拒否 not_provisioned])
    C -- No --> G{provisioning}
    G -- auto --> H[users INSERT<br/>password_hash = NULL] --> E
    G -- link_only / invite_only --> R
```

自動作成時の値:

| 列 | 値 |
|---|---|
| `login` | email ローカル部 (衝突時は連番サフィックス) |
| `displayName` | `custom.name` → get-identity の `name` (§5.3) → email ローカル部 |
| `email` | アサーションの `email` |
| `passwordHash` | `NULL` (パスワードを持たないアカウント) |
| `role` | binding の `default_role` (既定 `general`) |

> **`name` は JWT の標準 claim ではない。** CF Access の application token に既定で
> 入るのは `aud` / `email` / `sub` / `iat` / `exp` / `nbf` / `iss` / `type` /
> `identity_nonce` / `country` / `custom` だけ。 氏名を使いたければ custom claim の
> 追加か get-identity 参照が要る。

### 5.3 get-identity (任意・初回リンク時のみ)

custom claim だけでは足りない属性 (氏名・IdP グループ・IdP 種別) が要る場合、
`https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity` を
`CF_Authorization` クッキー付きで呼ぶと完全な identity が返る
(`name` / `email` / `groups` / `idp.type` / `user_uuid` / `amr` / `geo` /
`oidc_fields.principalName` / `devicePosture`)。

- 呼ぶのは **Hub** (クッキーを持っているのは Hub 側)。 Cernere へは
  `auth.edge_assertion` の payload に `identity` として添える。
- Cernere は **この identity を信頼しない** (署名が無い)。 表示名や IdP 種別など
  「間違っていても権限に影響しない値」 の補完にだけ使う。 認可判断は必ず
  アサーション本体の検証結果に基づく。
- 呼ぶのは **初回リンク時と表示名が空のとき**だけ。 毎リクエストは叩かない。
- custom claim は Cookie サイズ制限のため **約 1KB でトリム**される (best-effort)。
  大きい属性 (グループ一覧など) は custom claim ではなく get-identity で取る。

> `users.email` には unique index がある。email 一致リンクを先に試さないと
> 自動作成が一意制約で落ちる。順序は必須。

---

## 6. JWKS の取得とキャッシュ

- 取得先: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- TTL 6 時間キャッシュ。 未知の `kid` を見たときのみ 1 回だけ強制再取得
  (鍵ローテーション追従。 再取得は projectKey 単位で 1 分に 1 回までに制限)
- 取得失敗時はキャッシュで継続。 **キャッシュも無ければ拒否** (fail-closed)

---

## 7. 本人確認 (identity-verification) の扱い

composite の端末チャレンジ (メール 6 桁コード) は本経路では **既定で省略**する。
上流の企業 IdP で MFA 済みであり、二重に社員へコード入力を求める実益が薄いため。

ただし `trusted_devices` への記録は行い、異常検知の材料は残す。
binding 単位で必須化できるよう `require_device_check` を持たせる。

---

## 8. 権限昇格 (step-up) は据え置き

エッジ経由で得たセッションには認証方式マーク (`refresh_sessions.auth_method =
'edge:cf_access'`) を付ける。既存の Action authentication (破壊的操作直前の
passkey User Verification、[`auth-flows.md`](../interface/auth-flows.md) 共通節) は
**そのまま適用**する。

> 日常操作は SSO 一発、危険操作は passkey。
> エッジ認証は「誰か」を保証するが「その端末を今操作しているのが本人か」は保証しないため、
> 資格情報・データ・権限に影響する操作の step-up は外さない。

---

## 9. 失効 (offboarding) の伝播

- CF Access のセッション失効 / IdP 側での無効化 → CF を通れない → Hub に到達できない。
  Hub 経由でしか Cernere トークンを使わない構成なので実害は小さい。
- ただし refresh token は 30 日有効なので、**refresh 時にもアサーションの再提示を必須**とする
  (`POST /api/auth/refresh` ではなく Hub が `auth.edge_assertion` を再実行する)。
  Hub は毎リクエストでヘッダを受け取るため追加コストはゼロ。
  → CF を通れなくなってから最大 60 分 (access token TTL) でセッションが死ぬ。
- `identity_nonce` を保持し CF API で能動的に失効確認する強化は、API トークン運用が
  必要なため **v2 送り** (任意)。

---

## 10. データモデル

migration は **037 以降**を取る (030〜035 は別途整合作業中のため空ける)。

```sql
CREATE TABLE IF NOT EXISTS edge_identities (
  id             uuid PRIMARY KEY,
  provider       text NOT NULL,             -- 'cf_access'
  team_domain    text NOT NULL,             -- '<team>.cloudflareaccess.com'
  subject        text NOT NULL,             -- 紐付けキー (§5.1)
  subject_source text NOT NULL,             -- 'idp_claim' | 'email'
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cf_sub         text,                      -- CF の sub。 監査用 (キーにしない)
  email          text,                      -- 最終観測値 (表示・突合用)
  idp_type       text,                      -- 'azureAD' / 'google' / 'onetimepin' ...
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, team_domain, subject)
);
CREATE INDEX IF NOT EXISTS idx_edge_identities_user ON edge_identities (user_id);

CREATE TABLE IF NOT EXISTS edge_idp_bindings (
  project_key           text PRIMARY KEY,
  provider              text NOT NULL DEFAULT 'cf_access',
  team_domain           text NOT NULL,
  aud_tags              jsonb NOT NULL,     -- ["<application aud tag>", ...]
  subject_claim         text,               -- custom claim 名 (例 'sub' / 'oid')。 NULL なら email を主キーにする
  allowed_email_domains jsonb NOT NULL,     -- ["example.co.jp"]
  provisioning          text NOT NULL,      -- 'auto' | 'link_only' | 'invite_only'
  default_role          text NOT NULL DEFAULT 'general',
  require_device_check  boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS auth_method text;
```

`allowed_email_domains` は **必須** (空配列は起動時/登録時に拒否)。CF 側ポリシーの
設定ミスで社外ユーザが通過しても Cernere で止める二重化のため。

---

## 11. 管理操作

WS module `edge_idp` (admin 専用)。OIDC client 管理 (`oidc_client`) と同型。

| action | 内容 |
|---|---|
| `register` | binding 登録 (project_key / team_domain / aud_tags / allowed_email_domains / provisioning) |
| `list` | 一覧 |
| `update` | aud_tags / allowed_email_domains / provisioning / default_role の更新 |
| `enable` / `disable` | 有効・無効 |

binding の変更は **破壊的操作**として Action authentication (passkey step-up) の対象に含める
(OIDC client の redirect URI 変更と同格)。

---

## 12. 実装ファイル (予定)

| 層 | ファイル |
|---|---|
| JWKS 取得/キャッシュ | `server/src/auth/edge-jwks.ts` |
| アサーション検証 + ID 解決 | `server/src/auth/edge-assertion.ts` |
| binding ストア | `server/src/project/edge-bindings.ts` |
| WS 配線 | `server/src/ws/project-dispatch.ts` (`auth.edge_assertion` を 1 case 追加) |
| 管理 module | `server/src/commands.ts` (`edge_idp`) |
| migration | `migrations/037_edge_identities.sql` |

### テスト (最低ライン)

署名不正 / `aud` 不一致 / 期限切れ / サービストークン / ドメイン外 / binding 無効 /
自動作成 / email リンク / 既存リンクの再訪 — の 9 ケース。

加えて subject 決定まわり:

- `subject_claim` 設定時に `custom` へ当該 claim が無ければ email フォールバックに落ちること
- CF の `sub` が変わっても (削除→再追加のシミュレーション) 同一ユーザに解決されること
- `identity` (get-identity 由来) に細工した `email` を入れても、認可判断が
  アサーション本体の `email` に基づくこと (署名なし入力を信頼しない回帰テスト)

---

## 13. 関連

- [`oidc-provider.md`](oidc-provider.md) — Cernere を IdP にする逆向きの構成
- [`identity-verification.md`](identity-verification.md) — 端末本人確認 (§7 で既定省略)
- [`user-project-row.md`](user-project-row.md) — `ensureUserProjectRow()` の発火点
- [`../interface/auth-flows.md`](../interface/auth-flows.md) — 認証経路一覧
- Corpus 側の受け口 (`CORPUS_AUTH_MODE=edge`) は LUDIARS/Corpus `DESIGN.md` §16
