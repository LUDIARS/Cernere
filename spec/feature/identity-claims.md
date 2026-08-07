# identity claims と user_data 横断検索

## 何を解くか

サービスが「Discord で個人メンションしたい」「今この状態のユーザ全員を出したい」を
やろうとすると、素朴には次の 2 つが Cernere に足りない。

1. `discord_id` は `project_data_<key>` ではなく Cernere 中核の `users` 行にある。
   `user_data.columns` の宣言では届かない。かといって `profile.get` に足すと
   全プロジェクトへ無条件開示になる。
2. `managed_project.get_user_data` は `userId` 指定の 1 行取得しかできない。
   行をまたぐ検索ができない。

## 原則 — Cernere はサービスの実態を知らない

この 2 つをサービス専用コマンド (`<service>_presence.*` のような) で足すと、
Cernere のコードにサービス名が焼き付く。可否の判定が
`if (projectKey !== "<service>")` になり、サービスが増えるたび Cernere を改修する
ことになる。

**判定材料は `managed_projects.schema_definition` だけに置く。**
Cernere は呼び出し元が何のサービスかを知らないまま解決できること。

| 開示するもの | 宣言の置き場所 | 所有者 |
|---|---|---|
| `project_data_<key>` の列 | `user_data.columns` | プロジェクト |
| `users` の identity 列 | `identity_claims` | **管理者** |

`identity_claims` を管理者所有にするのは、プロジェクトが `update_schema` で自己申告
できると identity 列を勝手に開示対象にできてしまうため。`data_sharing` と同じ扱いで、
プロジェクトクライアントからの送信は保存せず `adminOwnedFieldsPreserved` で報告する。

許可リストは `IDENTITY_CLAIMS` (`server/src/project/schema.ts`)。ここに無い列名は
定義に書かれていても claim として扱わない。

## コマンド

### `managed_project.get_identity_claims`

```json
{ "userId": "...", "claims": ["discord_id"] }
```

宣言済みの claim のみ返す。`claims` 省略時は宣言済み全件。
**未宣言は fail-closed で拒否** — 空オブジェクトを黙って返すと設定不備が発見できない。

### `managed_project.resolve_user_by_claim`

```json
{ "claim": "discord_id", "value": "1234567890" }
```

claim の値からユーザを逆引きする (bot が Discord ID で本人を引く用途)。
宣言していない claim では引けない。値はパラメータで渡し、識別子だけを補間する。

### `managed_project.list_user_data`

```json
{
  "columns": ["available_now", "available_until"],
  "where": { "available_now": true },
  "activeAt": { "column": "available_until" },
  "claims": ["discord_id"],
  "limit": 200
}
```

`project_data_<key>` を `users` と join して列挙する。述語は 2 種類だけ:

- `where` — 宣言済みカラムの等値比較 (AND)
- `activeAt` — timestamp カラムの未失効判定 (`IS NULL OR > now()`)。NULL = 無期限

`columns` / `where` / `activeAt` に **宣言済みでない列名を渡すと拒否する**。
無言で無視すると「条件が効いていない結果」が正常応答として返るため。
論理削除 (`_deleted`) 済みの列も宣言済みとは扱わない。

`limit` は既定 200 / 上限 1000。

## 「おれひま」相当をこの上で実現する

サービス側は Cernere を改修せずに次で完結する。

1. `managed_project.update_schema` で `available_now` (boolean) と
   `available_until` (timestamp) を `user_data.columns` に宣言する。
   `project_data_<key>` の DDL は `schema-migrator` が生成する。
2. 管理者が当該プロジェクトの `identity_claims` に `discord_id` を追加する。
3. フラグ更新は既存の `managed_project.set_user_data`。
4. 「今ひまな人」一覧は `list_user_data` に上記 `where` + `activeAt` + `claims`。

Cernere 側にサービス名は一切現れない。

## 関連

- `server/src/project/identity-claims.ts` — claim の宣言検査と開示
- `server/src/project/user-data-query.ts` — 横断検索
- `server/src/project/schema-migrator.ts` — 宣言から `project_data_<key>` を生成
- `migrations/040_identity_claims.sql` — `users.discord_id` / `discord_username`
- [`../interface/auth-flows.md`](../interface/auth-flows.md) — Discord link/unlink フロー
