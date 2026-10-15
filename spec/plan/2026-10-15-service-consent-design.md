# サービス初回ログイン時の権限確認 (同意) 設計

- 日付: 2026-10-15
- 依頼: neco「サービス連携するにあたり初ログイン時に権限確認やって欲しい。権限は必須と推奨があり、
  必須は許可しないと進めない仕組み。他人が読み取れるかもユーザに通知するべく記載。
  これは Cr 実装するサービスで全て考慮する必要がある。」
- 状態: 実装済み (branch `feat/service-consent`、タスク `actio:172e2c99-1285-4a32-83c7-74948b92ae74`)。実装で決めたことは §9

## 1. 目的と範囲

Cernere 経由でサービス (managed project / OIDC client) に初めてログインするとき、そのサービスが使う権限を
利用者に一覧で見せ、許可を記録してからログインを完了させる。

1. 権限は **必須 (required)** と **推奨 (recommended)** に分かれる。必須を 1 つでも拒否すると、そのサービスへは
   ログインできない。推奨は外して進める。
2. 各権限に **誰が読めるか** (本人だけ / そのサービスの他の利用者 / 他のサービス / 公開) を表示する。
3. 同意は Cernere が保存し、サービスが権限を増やしたとき (宣言の版が上がり、未同意の権限が増えたとき) だけ再確認する。
4. 推奨を外した権限は、Cernere がデータを渡す側 (profile / user_data / identity claim / data_sharing) で拒否する。
   画面だけの同意にしない。
5. 対象は Cernere がサービス向けに認証結果を渡す **全経路** (§4)。経路ごとに個別実装せず、1 か所の判定に寄せる。

範囲外: Cernere 自身 (`audience = "cernere"`) へのログイン、サービス間 (project / tool / workload) 認証。

## 2. 現状 (2026-10-15 時点の main)

| 既存の仕組み | 何をしているか | 本設計との関係 |
|---|---|---|
| `/oidc/consent` (`frontend/src/pages/oidc/OidcConsentPage.tsx`) | OIDC authorize ごとに scope を見せて承認 | 同意を保存しない・必須/推奨の区別なし。§4 の 1 経路として統合する |
| `profile_access` / `identity_claims` / `data_sharing` / `service_scopes` (schema_definition の管理者所有フィールド) | サービスが **読めてよい上限** を管理者が決める | 同意はこの上限の内側でだけ効く。同意で上限を広げることはない |
| `user_data_optouts` (`module:<key>`) + `/data-optout` | 利用開始後の事後オプトアウト | 推奨権限の拒否と同じ表に寄せる (§5.3) |
| `user_profiles.privacy` | プロフィール項目の公開/非公開 | 「誰が読めるか」の表示に使う |
| authCode `audience` (`server/src/auth/auth-code.ts`) | service 向けは active 必須 | 同意判定を同じ関門に足す |

projectKey が authCode 発行時に分からない経路がある (silent SSO・popup の `target`、edge assertion、
REST の composite login)。`target` origin → `managed_projects.schema_definition.endpoint.frontend_url` の
origin で逆引きする解決器を新設する (§4.2)。

## 3. 権限の宣言 (サービス側)

`schema_definition` に `consent` を追加する。**サービス (project client) が `update_schema` で宣言してよい**
フィールドとする。ただし保存時に管理者所有の上限 (§2) と突き合わせ、上限外の権限は保存を拒否する
(自己付与の禁止は維持)。

```yaml
consent:
  version: 3                    # 宣言を変えたら上げる。単調増加 (下げる更新は拒否)
  permissions:
    - key: profile.displayName  # §3.1 の語彙
      level: required           # required | recommended
      purpose: "メンバー一覧に名前を出すため"
      visible_to: [service_users]   # §3.2。省略不可
    - key: profile.email
      level: recommended
      purpose: "締切のお知らせをメールで送るため"
      visible_to: [self]
    - key: user_data.module:calendar
      level: recommended
      purpose: "予定を Google Calendar と同期するため"
      visible_to: [self]
```

### 3.1 権限キーの語彙

| key | 対応する上限 | 拒否時に止める場所 |
|---|---|---|
| `identity.basic` | (常に許可: user id) | 必須固定。宣言が無くても表示する |
| `profile.<field>` | `profile_access.read` / `write` | `profile.get` / `profile.update` |
| `identity_claim.<claim>` | `identity_claims` | identity claim 取得 |
| `user_data.module:<module>` | `user_data.columns[*].module` | user_data の get/set (既存 opt-out と同じ判定) |
| `oidc.<scope>` | `oidc_clients.scopes` | OIDC id_token / userinfo の claim |

`<field>` 等は既存の許可リストに無い値なら宣言を拒否する (自由文字列にしない)。

### 3.2 `visible_to`

| 値 | 画面の文言 | 根拠 |
|---|---|---|
| `self` | あなただけ | サービスの申告 |
| `service_users` | このサービスの他の利用者 | サービスの申告 |
| `public` | 誰でも (ログインしていない人を含む) | サービスの申告 |
| (自動付与) `other_services` | 他のサービス: <名前> | Cernere が `data_sharing` から計算して足す。サービスは書けない |

サービスの申告は Cernere が検証できないため、画面には「サービスの申告」と出所を書く。
`other_services` は Cernere 自身が渡しているので確定情報として出す。
`profile.<field>` の `bio` 等は `user_profiles.privacy` が public のときだけ他人に見えるので、その旨も添える。

### 3.3 宣言が無いサービス

`consent` 未宣言のサービスは移行モード (§6) に従う。enforce 時は `identity.basic` だけを必須として表示し、
上限で許可されている他の権限は **すべて推奨扱い** で表示する (黙って渡さない)。

## 4. 判定の関門

### 4.1 1 か所に寄せる

`server/src/consent/` を新設し、次の純粋関数と保存層に分ける (SRP)。

- `consent/declaration.ts` — 宣言の Zod スキーマと上限との突き合わせ
- `consent/requirement.ts` — `(宣言, 上限, data_sharing, 保存済み同意) → { satisfied, missingRequired[], pendingRecommended[], view }`
- `consent/store.ts` — `user_service_consents` の読み書き
- `consent/project-resolver.ts` — projectKey / target origin / OIDC client id → 対象サービス

service 向け authCode の発行 (`issueAuthCode` で `audience === "service"`) に **対象サービス** を必須引数として
足し、`requireActiveUser` の直後で同意を判定する。未充足なら authCode を出さず
`ConsentRequiredError { consentTicket }` を投げる。

### 4.2 経路ごとの扱い

| 経路 | 対象の特定 | 同意が要るとき |
|---|---|---|
| ダッシュボード「開く」 (`managed_project.open_url`) | projectKey | `{ consentRequired: true, consentUrl }` を返し、ダッシュボードが `/consent` へ遷移 |
| popup / redirect の `target` (`compositeSessionCode` 等) | target origin → frontend_url | popup 内で `/consent` を表示してから authCode を親へ返す |
| silent SSO (iframe・画面なし) | target origin | `consent_required` を返す。サービスは popup (対話) に切り替える |
| project WS 経由 composite (`ws/composite-auth.ts`) | 接続の projectKey | `consent_required` + `consentUrl` を返し、サービスが popup で開く |
| edge assertion (`auth/edge-assertion.ts`) | connection の projectKey | Cernere の `/consent` へ redirect 後に元の継続 URL へ戻す |
| OIDC authorize | client_id | 既存 `/oidc/consent` を同じ `requirement.ts` の表示データで描く。保存済みなら省略 |

`consentTicket` は Redis に短命 (10 分) で `{ userId, target, returnTo, declarationVersion }` を保存し、
同意完了後の継続先を決める。継続先は発行時に検証済みの値だけを使い、`/consent` のクエリから受け取らない
(open redirect 防止)。

### 4.3 同意画面 (`frontend/src/pages/consent/ConsentPage.tsx`)

- 上段「必須」: チェック固定。拒否ボタンを押すとログインを中止し、サービスへ `consent_denied` を返す。
- 下段「推奨」: 既定は **オフ** (利用者が選んで入れる)。各行に目的と「誰が読めるか」。
- 「他の利用者・他のサービス・公開」に当たる行は目立つ印を付ける。
- 再確認時は、前回から増えた権限だけを強調する。
- 同意後も `/data-optout` (表示名を「サービスの権限」に改める) から推奨の取り消し・必須の取り消し (= そのサービスの
  利用停止) ができる。

## 5. データ

### 5.1 migration `070_user_service_consents.sql`

```sql
CREATE TABLE IF NOT EXISTS user_service_consents (
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_kind         TEXT NOT NULL CHECK (subject_kind IN ('project', 'oidc_client')),
    subject_key          TEXT NOT NULL,          -- managed_projects.key / oidc_clients.client_id
    declaration_version  INTEGER NOT NULL,
    granted              JSONB NOT NULL,         -- 許可した permission key の配列
    denied               JSONB NOT NULL,         -- 外した推奨の配列
    decided_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at           TIMESTAMPTZ,
    PRIMARY KEY (user_id, subject_kind, subject_key)
);

CREATE TABLE IF NOT EXISTS consent_decisions (    -- 監査 (追記のみ)
    id                   UUID PRIMARY KEY,
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_kind         TEXT NOT NULL,
    subject_key          TEXT NOT NULL,
    declaration_version  INTEGER NOT NULL,
    action               TEXT NOT NULL CHECK (action IN ('grant', 'deny', 'revoke', 'update')),
    granted              JSONB NOT NULL,
    denied               JSONB NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_decisions_user ON consent_decisions (user_id, created_at);
```

番号は着手時点の main と未マージブランチを見て採番し直す。

### 5.2 再確認の条件

`declaration_version` が保存値より大きく、かつ新版の権限集合が保存済みの `granted ∪ denied` に含まれない
権限を持つときだけ再確認する。文言 (purpose) だけの変更では再確認しない。
必須から外れた権限は自動で推奨扱いになり、許可は保ったままにする。

### 5.3 拒否の効き方

推奨の拒否・取り消しは `user_data_optouts` と同じ判定関数で読む。`user_data.module:*` は既存の
`module:<key>` category をそのまま使い、`profile.*` / `identity_claim.*` は `consent:<permission key>` category を
同じ表に足す。拒否時のデータ NULL 化は既存 opt-out と同じく module 単位だけで行い、profile は
「渡さない」だけにする (共通プロフィールそのものは消さない)。

## 6. 移行 (全サービス)

`schema_definition.consent_mode` (管理者所有) をサービスごとに持つ。

| mode | 動作 |
|---|---|
| `off` (既定) | 判定しない。宣言の検証だけ行う |
| `warn` | 判定し、未充足でもログインは通す。`consent.would_block` を記録 |
| `enforce` | 未充足ならログインを止め、`/consent` へ |

全サービスで `enforce` にしたら既定を `enforce` に変える (未宣言サービスは §3.3)。
既存の利用者は保存済み同意が無いため、`enforce` 切替後の最初のログインで 1 度だけ同意画面が出る。

各サービスでの対応 (Cernere の外の作業):

1. `consent` の宣言を書く (必須/推奨・目的・visible_to)。上限外は保存できないので、必要なら管理者に上限を頼む。
2. silent SSO・project WS 経路で `consent_required` を受けたら popup に切り替える。
3. `consent_denied` を受けたら「権限が許可されなかったため利用できません」を出す。
4. 推奨が拒否された項目が `null` / 拒否で返ってくる前提で画面を作る。

対象サービスの一覧は `managed_projects` と `oidc_clients` の登録から作り、Actio にサービスごとのタスクとして積む。

## 7. 実装の分け方

1. 宣言スキーマ・上限との突き合わせ・`requirement.ts` (純粋関数とテスト)
2. migration と `store.ts`、WS `consent.get` / `consent.decide` (本人セッション、action proof)
3. `project-resolver.ts` と `issueAuthCode` の関門 (`consent_mode` 付き、既定 off)
4. 各経路の `consent_required` 応答 (§4.2) と `/consent` 画面、OIDC 同意画面の統合
5. データ提供側での拒否反映 (§5.3) と `/data-optout` の改修
6. spec 更新 (`spec/interface/auth-flows.md`、`spec/setup/service-registration.md` に宣言の書き方)

既定 `off` で入れるので、マージ時点で既存サービスのログインは変わらない。

## 8. 決めること (neco)

- 推奨の既定をオフにする (本設計) か、オンにして外せるようにするか。個人データを渡す初期値なので本設計はオフ。
- 未宣言サービスを `enforce` 時に通すか (本設計は `identity.basic` だけ必須・残りは推奨として表示して通す)。

## 9. 実装で決めたこと (2026-10-15)

- migration は `070_user_service_consents.sql` (着手時点の main・未マージブランチ・worktree の最大は 069)。
  OIDC client には `schema_definition` が無いので、`oidc_clients.consent_mode` / `consent` 列を同じ migration で足した
  (管理者が WS `oidc_client.update_consent` で設定)。
- §8 の未決 2 点は設計書どおり: 推奨の既定はオフ、未宣言サービスは `identity.basic` だけ必須・残りを推奨で表示。
- consentTicket はチャネルを持つ。サービスの backend を経由した ticket (project WS / edge) は本人の Cernere セッションが
  無いと判断できない (サービスの代理同意を防ぐ)。Cernere の画面が受け取った ticket は Cernere の Origin からも判断できる。
- 継続先が無い ticket と edge の ticket は同意後に authCode を作らない (edge は Hub がアサーションを再送する)。
- `consent:<key>` の拒否は profile / identity claim を「渡さない」だけで、peer relay の opt-out ゲートには数えない
  (module の opt-out は従来どおり relay を止める)。
- 同意の判断の WS (`consent.decide` / `consent.revoke`) は action proof を取る。ログイン途中の `/consent` は REST
  (popup の composite ログインは Cernere のセッションを持たないことがあるため) で、ticket と Origin / 本人セッションで守る。
- 契約: C-23 宣言の検証 / C-24 要件判定 / C-25 関門の方針 / C-26 継続先 (open redirect 防止)。

