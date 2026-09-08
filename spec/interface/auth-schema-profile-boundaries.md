# トークン用途・既定値・共通プロフィールの境界

2026-09-08。実装対象は Cernere。変更理由は
[問題記録](../plan/problem_logs/2026-09-08-auth-schema-profile-boundaries.md) を参照。

## トークン用途の分離

通常認証は署名だけでなく `tokenType=user_access`、非空の `sub` / `role`、整数の
`iat` / `exp` と有効期限を検証する。HS256 に限定する。
`mfa_challenge` / `tool` / `project` と用途なしの旧 JWT は通常認証で拒否する。
これにより MFA 待ち JWT を WS 接続・REST の本人操作・OIDC 承認へ流用できない。

tool は `tokenType=tool` を持ち、専用 `verifyToolToken` で検証する。
顔写真などの service scope 入口だけが tool と管理者 user の両方を明示的に受理し、
現在の DB 上の active / owner / scope、または現在の管理者 role を確認する。
project の既存検証器と署名形式は継続する。

旧 MFA JWT 由来の WS session が残る可能性があるため、Redis session に
`authenticationVersion: 2` を付け、新しい正規認証経路が保存した session だけを再開する。
旧 session の自動昇格や互換受理はしない。

当初の境界修正では、照合器がない composite MFA の任意コード成功を廃止し、503 で拒否した。
後続の [Authenticator / メール MFA](../feature/mfa-authenticator.md) で実検証を配線する。
完了器を実装しても用途分離は保持し、検証と一回限りの消費後にのみ通常ログインへ進む。
Cloudflare と企業認証を統合する案は
[企業 SSO 提案](../plan/enterprise-sso-cloudflare-cernere-20260908.md) に分ける。

## スキーマ既定値は SQL 式ではなく値

`default_value` は長さ 16,384 文字以下の文字列で指定する。未指定と空文字は区別する。
すべての指定値を schema 検証時と migrator の DDL 開始前に検査する。

| 型 | 受理する値 | SQL 化 |
|---|---|---|
| text | NUL を含まない文字列。空文字も可 | 単一引用符とバックスラッシュを escape した E リテラル |
| integer | 符号付き整数、32 bit 範囲内 | 正規化した整数リテラル |
| bigint | 符号付き整数、64 bit 範囲内 | BigInt で範囲確認した整数リテラル |
| boolean | true / false（大文字小文字を許容） | 正規化した boolean リテラル |
| json | JSON として構文が正しい文字列 | 元の数値精度を保って E リテラル化し jsonb cast |
| uuid | ハイフン付き UUID | E リテラル化し uuid cast |
| timestamp | timezone 付き ISO 日時 | E リテラル化し timestamptz cast |

`now()`、`gen_random_uuid()`、演算、サブクエリは既定値として受け付けない。
text 内に SQL に見える文字列があっても文字列の値として保存する。
システム管理列の `created_at` 等にある固定 `now()` は利用者入力ではなく従来どおり。
CREATE と ALTER は同じ serializer を使用し、旧 `escapeDefault` は削除する。
既存 DB 列の DEFAULT を後から置換する処理は追加しない。

## 共通プロフィールのサービス認可

`managed_projects.schema_definition.profile_access` に管理者が grant を保存する。
既存 JSONB 内の追加フィールドであり、SQL migration は不要。
未設定・不正形式・inactive project は拒否する。project WS の payload 内の projectKey を
信用せず、認証済み接続の projectKey から grant を読む。

管理者用 `managed_project.update_schema` に渡す定義の例:

```json
{
  "profile_access": {
    "users": ["123e4567-e89b-42d3-a456-426614174000"],
    "read": ["displayName", "avatarUrl", "bio"],
    "write": ["bio"]
  }
}
```

これは定義内の該当部分。更新時には現在の `user_data` 等も保持して送る。
`users` は対象ユーザー UUID 配列。空配列は全拒否。
全ユーザーが必要なサービスのみ管理者が明示的に `"all"` とする。
`read` / `write` は必須で、省略による全許可はない。

| 操作 | 許可可能な項目 | 応答 |
|---|---|---|
| profile.get | login, displayName, email, avatarUrl, role, bio, roleTitle, expertise, hobbies | id と許可された項目 |
| profile.update | displayName, avatarUrl, bio, roleTitle, expertise, hobbies | id と updated（更新した項目名） |

get は `{userId, fields?}` を受け取る。fields 省略時は grant.read のみを返し、
要求に未許可項目が含まれる場合はリクエストを拒否する。privacy の生データは返さない。
bio / roleTitle / expertise / hobbies は既存 privacy が明示的に public の場合のみ公開し、
core または呼び出しサービスの personality opt-out があれば公開しない。

#### SPEC-PROFILE-INPUT-BOUNDARY

update は厳密に payload を検査し、role / email / privacy 等の未知項目を拒否する。
文字数・配列件数を制限し、avatarUrl は http/https または null とする。
対象 user と全項目の許可、personality opt-out を確認してから transaction 内で更新する。
一部の項目が拒否されたリクエストで他の項目だけを書き込まない。
write だけの grant が更新後のプロフィール全体を読み取ることもできない。

grant は操作の transaction 中に shared row lock を保持して検査する。
project 自身の `managed_project.update_schema` では `profile_access` を変更できず、
省略された grant は保持される。定義保存は読取時の JSONB と一致する場合に限り行い、
途中で変更された場合は 409 を返す。これにより古い auto-sync が取り消した grant を戻さない。
409 までに追加済みの DDL が残る場合はあるが、grant は上書きしない。再取得して再試行する。
プロフィール・grant 関連の SQL parameter は開発ログでも伏せる。

## 反映時の互換性と確認範囲

- 旧 user access token / tool token / Redis session は受理されなくなる。
  user は再ログインまたは既存の正規 refresh 経路で更新し、tool は client credentials で再取得する。
  refresh_sessions を一括削除する変更は含まない。
- MFA 設定済みの password login は、登録済み TOTP / メールコードの実検証が必要。
  利用可能な別認証手段の事前確認と、MFA 後続仕様の migration・秘密設定が必要。
- profile API 利用サービスには管理者が必要最小限の grant を設定する。
  自動で全ユーザー・全項目を付与する移行は行わない。更新応答の変更に利用側を合わせる。
- SQL 式の既定値を使った既存定義は値へ置き換えてから再保存する。
  既存 DB に設定済みの DEFAULT や既に起きた不正操作を修復・調査したとは扱わない。
- `tsc --noEmit -p server/tsconfig.json` で静的型検査する。
  ユーザー方針により単体・統合・起動テストは追加・実行せず、サービスの再起動も行わない。

実装: `auth/jwt.ts`, `redis.ts`, `http/composite-handler.ts`,
`project/column-default.ts`, `project/schema.ts`, `project/schema-migrator.ts`,
`project/profile-{access,input,service}.ts`, `project/service.ts`,
`ws/project-dispatch.ts`, `logging/dev-logger.ts`（すべて `server/src` 配下）。
