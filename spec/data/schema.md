# DB スキーマ詳細

Cernere 所有テーブルの列定義一覧。型は PostgreSQL 型で表記
（`timestamptz` = `timestamp with time zone`）。出典:
[`server/src/db/schema.ts`](../../server/src/db/schema.ts) / `migrations/*.sql`。

> 除外: 動的 `project_data_<key>` テーブル（他サービス委託データ）。スコープは
> [`README.md`](./README.md) を参照。

---

## 認証・ユーザー

### `users`
ユーザー本体。GitHub/Google OAuth・パスワード・MFA。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| github_id | bigint | UNIQUE, null 可 |
| login | text | NOT NULL |
| display_name | text | NOT NULL |
| avatar_url | text | null 可 |
| email | text | null 可 |
| role | text | NOT NULL, default `'general'` |
| password_hash | text | null 可（bcrypt） |
| google_id | text | UNIQUE, null 可 |
| google_access_token | text | null 可 |
| google_refresh_token | text | null 可 |
| google_token_expires_at | bigint | null 可（epoch ms） |
| google_scopes | jsonb | null 可 |
| totp_secret | text | null 可 |
| totp_enabled | boolean | NOT NULL, default false |
| phone_number | text | null 可 |
| phone_verified | boolean | NOT NULL, default false |
| mfa_enabled | boolean | NOT NULL, default false |
| mfa_methods | jsonb | NOT NULL, default `[]` |
| last_login_at | timestamptz | null 可 |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_users_email` (email, unique)

### `refresh_sessions`
リフレッシュトークン（既定 30 日）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id (ON DELETE CASCADE) |
| refresh_token | text | NOT NULL, UNIQUE |
| expires_at | timestamptz | NOT NULL |
| created_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_refresh_sessions_user_id` (user_id), `idx_refresh_sessions_token` (refresh_token)

### `verification_codes`
MFA / メール確認の使い捨てコード。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| code | text | NOT NULL |
| method | text | NOT NULL（totp/sms/email 等） |
| expires_at | timestamptz | NOT NULL |
| used | boolean | NOT NULL, default false |
| created_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_verification_codes_user_id` (user_id)

### `trusted_devices`
本人確認済みデバイス（デバイスフィンガープリント + 地理情報）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| device_hash | text | NOT NULL |
| label | text | NOT NULL |
| machine_info | jsonb | NOT NULL, default `{}` |
| browser_info | jsonb | NOT NULL, default `{}` |
| geo_info | jsonb | NOT NULL, default `{}` |
| last_ip | text | null 可 |
| first_seen_at | timestamptz | NOT NULL, default now() |
| last_seen_at | timestamptz | NOT NULL, default now() |
| revoked_at | timestamptz | null 可 |

- INDEX: `idx_trusted_devices_user` (user_id), `idx_trusted_devices_user_last_seen` (user_id, last_seen_at)

### `passkeys`
WebAuthn / FIDO2 公開鍵（1 user に複数可）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| credential_id | text | NOT NULL（base64url） |
| public_key | bytea | NOT NULL（COSE bytes） |
| counter | bigint | NOT NULL, default 0 |
| device_type | text | NOT NULL, default `'singleDevice'` |
| backed_up | boolean | NOT NULL, default false |
| transports | jsonb | NOT NULL, default `[]` |
| nickname | text | null 可 |
| aaguid | text | null 可 |
| created_at | timestamptz | NOT NULL, default now() |
| last_used_at | timestamptz | null 可 |

- INDEX: `idx_passkeys_credential_id` (credential_id, unique), `idx_passkeys_user` (user_id, created_at)

### `user_profiles`
プロフィール。`user_id` が PK（1:1）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| user_id | uuid | PK, FK → users.id (CASCADE) |
| role_title | text | NOT NULL, default `''` |
| bio | text | NOT NULL, default `''` |
| expertise | jsonb | NOT NULL, default `[]` |
| hobbies | jsonb | NOT NULL, default `[]` |
| privacy | jsonb | NOT NULL, default `{bio,roleTitle,expertise,hobbies: true}` |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### `user_data_optouts`
サービス×カテゴリ単位のデータ提供オプトアウト。複合 PK。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| user_id | uuid | PK(1/3), FK → users.id (CASCADE) |
| service_id | text | PK(2/3) |
| category_key | text | PK(3/3) |
| opted_out_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_user_data_optouts_user` (user_id), `idx_user_data_optouts_user_service` (user_id, service_id)

---

## 組織・プロジェクト定義

### `organizations`

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| name | text | NOT NULL |
| slug | text | NOT NULL, UNIQUE |
| description | text | NOT NULL, default `''` |
| created_by | uuid | NOT NULL, FK → users.id |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### `organization_members`
複合 PK (organization_id, user_id)。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| organization_id | uuid | PK(1/2), FK → organizations.id (CASCADE) |
| user_id | uuid | PK(2/2), FK → users.id (CASCADE) |
| role | text | NOT NULL, default `'member'`（owner/admin/member） |
| joined_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_org_members_user` (user_id)

### `project_definitions`
プロジェクト定義（静的）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| code | text | NOT NULL, UNIQUE |
| name | text | NOT NULL |
| data_schema | jsonb | NOT NULL, default `{}` |
| commands | jsonb | NOT NULL, default `[]` |
| plugin_repository | text | NOT NULL, default `''` |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### `organization_projects`
組織×プロジェクト定義の有効化。複合 PK。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| organization_id | uuid | PK(1/2), FK → organizations.id (CASCADE) |
| project_definition_id | uuid | PK(2/2), FK → project_definitions.id (CASCADE) |
| enabled_at | timestamptz | NOT NULL, default now() |

---

## 動的プロジェクト管理

### `managed_projects`
実行時に登録される外部サービス。`key` が PK。`schema_definition` が
動的 `project_data_<key>` テーブルの形を決める。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| key | text | PK |
| name | text | NOT NULL |
| description | text | NOT NULL, default `''` |
| client_id | text | NOT NULL, UNIQUE |
| client_secret_hash | text | NOT NULL |
| schema_definition | jsonb | NOT NULL, default `{}` |
| is_active | boolean | NOT NULL, default true |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_managed_projects_client_id` (client_id)

### `project_definition_history`
プロジェクト定義の版履歴。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK, default random |
| project_key | text | NOT NULL, FK → managed_projects.key (CASCADE) |
| definition | jsonb | NOT NULL |
| version | integer | NOT NULL, default 1 |
| applied_by | uuid | null 可, FK → users.id |
| created_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_project_def_history_key` (project_key)

### `relay_pairs`
service adapter 同士の peer 直結許可。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK, default random |
| from_project_key | text | NOT NULL, FK → managed_projects.key (CASCADE) |
| to_project_key | text | NOT NULL, FK → managed_projects.key (CASCADE) |
| bidirectional | boolean | NOT NULL, default true |
| is_active | boolean | NOT NULL, default true |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- INDEX: `uq_relay_pairs_from_to` (from_project_key, to_project_key, unique), `idx_relay_pairs_from` (from_project_key), `idx_relay_pairs_to` (to_project_key)

---

## サービス / ツール認証

### `tool_clients`
CLI / API ツールの client credentials。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| name | text | NOT NULL |
| client_id | text | NOT NULL, UNIQUE |
| client_secret_hash | text | NOT NULL |
| owner_user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| scopes | jsonb | NOT NULL, default `[]` |
| is_active | boolean | NOT NULL, default true |
| last_used_at | timestamptz | null 可 |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_tool_clients_client_id` (client_id), `idx_tool_clients_owner` (owner_user_id)

### `service_registry`
登録された連携サービス。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| code | text | NOT NULL, UNIQUE |
| name | text | NOT NULL |
| service_secret_hash | text | NOT NULL |
| endpoint_url | text | NOT NULL |
| scopes | jsonb | NOT NULL, default `[]` |
| is_active | boolean | NOT NULL, default true |
| last_connected_at | timestamptz | null 可 |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### `service_tickets`
SSO ハンドオフ用 one-time チケット。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| service_id | uuid | NOT NULL, FK → service_registry.id (CASCADE) |
| ticket_code | text | NOT NULL, UNIQUE |
| user_data | jsonb | NOT NULL |
| organization_id | uuid | null 可 |
| scopes | jsonb | NOT NULL, default `[]` |
| expires_at | timestamptz | NOT NULL |
| consumed | boolean | NOT NULL, default false |
| created_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_service_tickets_code` (ticket_code)

---

## 委託データ保管

### `project_oauth_tokens`
「個人データ単一情報源」ルールに基づき、各プロジェクトの代わりに OAuth
トークンを保管する（**行データは委託物**。テーブル定義は Cernere 所有）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK, default random |
| project_key | text | NOT NULL |
| user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| provider | text | NOT NULL |
| access_token | text | null 可 |
| refresh_token | text | null 可 |
| expires_at | timestamptz | null 可 |
| token_type | text | null 可 |
| scope | text | null 可 |
| metadata | jsonb | NOT NULL, default `{}` |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_oauth_tokens_project_user_provider` (project_key, user_id, provider, unique), `idx_oauth_tokens_project_user` (project_key, user_id), `idx_oauth_tokens_project_provider` (project_key, provider)

---

## ユーザーデータ（汎用）

### `projects`
ユーザーごとの汎用プロジェクトデータ（jsonb 格納）。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id (CASCADE) |
| name | text | NOT NULL |
| data | jsonb | NOT NULL |
| updated_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_projects_user_id` (user_id)

### `project_settings`
`projects` のキー値設定。複合 PK。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| project_id | uuid | PK(1/2), FK → projects.id (CASCADE) |
| setting_key | text | PK(2/2) |
| value | text | NOT NULL |
| updated_at | timestamptz | NOT NULL, default now() |

---

## 監査

### `operation_logs`
全メソッド呼び出し（成功・失敗とも）の監査ログ。

| 列 | 型 | 制約 / 既定 |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → users.id |
| session_id | text | NOT NULL |
| method | text | NOT NULL |
| params | jsonb | NOT NULL, default `{}` |
| status | text | NOT NULL |
| error | text | null 可 |
| created_at | timestamptz | NOT NULL, default now() |

- INDEX: `idx_operation_logs_user` (user_id), `idx_operation_logs_session` (session_id), `idx_operation_logs_method` (method), `idx_operation_logs_created` (created_at)
