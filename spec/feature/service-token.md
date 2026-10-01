# service 文脈の token と service_scopes 宣言

認証集約 (Corpus `spec/plan/auth-plane-consolidation.md`) の P2 / P3 の Cernere 側。
Actio: `actio:bc7011da-9494-472f-a3aa-dc4ee72448f4`

## 何を解くか

既存の `POST /api/auth/project-token` はログイン中ユーザの token を前提にするため、
ユーザ不在の service 間呼び出し (scheduler の巡回、persona export など) を通せない。
その穴を各サービスが手配布の固定トークンで埋めていた。

## 発行 API (P2)

```
POST /api/auth/service-token
{ "client_id": "...", "client_secret": "...", "target_project_key": "EducationLab" }
```

応答:

```json
{ "tokenType": "service", "accessToken": "v4.public...", "expiresIn": 900,
  "subject": "volputas", "audience": "glab", "scope": ["review-relay:write"], "alg": "EdDSA" }
```

- 資格情報は Cernere project client credentials (Excubitor `cernere_launch_credentials` で配布) のみ。
  Cernere 以外へ送らない。発行済み token は呼出元 process memory にのみキャッシュする。
- token は PASETO v4 (Ed25519)。署名鍵と検証経路は user 版と同じ
  (`/.well-known/cernere-public-key`)。`kind: "service"` で user 版と区別する。
- claims は **request body から受け取らず**、`managed_projects` の登録情報から解決する。

| claim | 値 |
|---|---|
| `sub` | 認証済み呼出元の `storage_slug` (不変。key の改名で変わらない) |
| `aud` | `target_project_key` で引いた呼出先の `storage_slug` |
| `scope` | 呼出元の `service_scopes` 宣言 (重複除去・昇順) |

- 失敗時: 資格情報不一致 / 呼出元無効 → 401、呼出先不在 / 無効 → 404、
  `service_scopes` 未宣言 → 403 (fail-closed)、PASETO 鍵未設定 → 503。
- rate limit: `service_token:<client_id>` 60 回 / 300 秒。

実装: `server/src/auth/service-token.ts` (claims・署名・検証)、
`server/src/project/service-token-issuer.ts` (登録情報からの解決)。

## service_scopes 宣言 (P3)

```json
{ "service_scopes": ["review-relay:write", "persona-export:read"] }
```

- `managed_projects.schema_definition` の **管理者所有フィールド**。`identity_claims` と同じく
  project client の `managed_project.update_schema` では保存されず
  (`adminOwnedFieldsPreserved` で報告)、auto-sync で省略されても既存値を保持する。
- 形式は `<resource>:<action>` (小文字・数字・ハイフン、64 文字以内)。語彙は受け側が決めるため
  列挙はしない。Cernere 自身の face 系 scope (`face-revocation:read` / `face-consent:read` /
  `face-consent:revoke`) も同じ語彙で宣言でき、宣言すれば service token に載る。
- 受け側は呼出元名で分岐せず、署名・`exp`・自分の識別子と `aud` の一致・endpoint が要求する
  scope を照合する (参照実装: `verifyServiceTokenPaseto` / `hasServiceScope`)。

## 範囲外

- Corpus `TokenProvider.getServiceToken` (Corpus 側)。
- 固定トークンの移行 (P4) と撤去 (P5)。
- Cernere 自身の face endpoint (`requireServiceScope`) が service token を受理すること。
  face 系 audit は `actorUserId` (人) を必須としており、service principal を記録する形を
  決めてから載せ替える。現行の tool token / admin 経路は変更していない。

## 判断が要る点

- **service token の TTL。** 現状は user 版と同じ 15 分 (`SERVICE_TOKEN_TTL_SEC`)。
  選択肢: (a) 15 分のまま (呼出元が期限前に取り直す)、(b) 常駐 scheduler 向けに 60 分
  (tool / project HS256 token と同じ)、(c) project ごとに宣言で上書き可能にする。
- **P4 移行中に受け側が新旧両方を受理する期間を設けるか。** 選択肢: (a) 設ける
  (受け側を先に両受理にし、送信側を切り替えた後に固定トークンを撤去)、(b) 設けない
  (送信側と受信側を同時にデプロイ)。Cernere 側はどちらでも追加変更は不要。
