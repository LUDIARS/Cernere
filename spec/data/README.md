# データスキーマ

Cernere（PostgreSQL 17 + Drizzle ORM）が **自身で定義・所有する** テーブルの一覧。
権威ソースは [`server/src/db/schema.ts`](../../server/src/db/schema.ts) と
`migrations/*.sql`。詳細な列定義は [`schema.md`](./schema.md) に列挙する。

## スコープ（含む / 除く）

- **含む**: Cernere がスキーマを定義・所有する静的テーブル（本書の 21 テーブル）。
  認証・ユーザー・組織・プロジェクト管理・サービス連携・監査など。
- **除く（他プロジェクトからの委託データ）**:
  - **動的 `project_data_<key>` テーブル** — managed project が登録されるたびに
    実行時生成される、その **外部サービスのユーザーデータ** 用テーブル。スキーマは
    `managed_projects.schema_definition`（= 各サービスが定義）で決まるため、
    Cernere の固定スキーマではない。**各サービス側の `spec/data/` で文書化する**。
  - `project_oauth_tokens` は Cernere 所有テーブルだが、中身は「個人データ単一
    情報源」ルールに基づき **各プロジェクトの代わりに預かる** OAuth トークン
    （委託データ）。テーブル定義は本書に含めるが、行データは委託物である点に注意。

## テーブル一覧（ドメイン別）

| ドメイン | テーブル | 概要 |
|---|---|---|
| 認証・ユーザー | `users` | ユーザー本体（GitHub/Google OAuth・パスワード・MFA・ロール） |
| | `refresh_sessions` | リフレッシュトークン（30 日） |
| | `verification_codes` | MFA / メール確認コード |
| | `trusted_devices` | 本人確認済みデバイス（フィンガープリント） |
| | `passkeys` | WebAuthn / FIDO2 公開鍵 |
| | `user_profiles` | プロフィール（bio / expertise・公開設定） |
| | `user_data_optouts` | サービス×カテゴリ単位のデータ提供オプトアウト |
| 組織・プロジェクト定義 | `organizations` | 組織 |
| | `organization_members` | 組織メンバー（owner/admin/member） |
| | `project_definitions` | プロジェクト定義（code・data_schema・commands） |
| | `organization_projects` | 組織×プロジェクト有効化 |
| 動的プロジェクト管理 | `managed_projects` | 動的登録された外部サービス（client_id/secret・schema_definition） |
| | `project_definition_history` | プロジェクト定義の版履歴 |
| | `relay_pairs` | service adapter 同士の peer 直結許可 |
| サービス / ツール認証 | `tool_clients` | CLI / API ツールの client credentials |
| | `service_registry` | 登録サービス（service secret・endpoint） |
| | `service_tickets` | SSO ハンドオフ用 one-time チケット |
| 委託データ保管 | `project_oauth_tokens` | プロジェクト別 OAuth トークン（個人データ単一情報源） |
| ユーザーデータ（汎用） | `projects` | ユーザーごとの汎用プロジェクトデータ（jsonb） |
| | `project_settings` | 上記のキー値設定 |
| 監査 | `operation_logs` | 全メソッド呼び出しの監査ログ |

> 列・型・制約・インデックス・外部キーの詳細は [`schema.md`](./schema.md)。
