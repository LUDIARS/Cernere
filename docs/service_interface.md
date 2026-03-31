# Cernere Service Interface

Cernere の全操作は WebSocket セッション中の `module_request` メッセージを通じて実行される。
外部公開 API は存在せず、フロントエンドのインタラクティブ認証によって確立された WS セッションのみが操作を受け付ける。

全操作は `operation_logs` テーブルに記録される（成功・失敗とも）。

## プロトコル

### リクエスト

```json
{
  "type": "module_request",
  "module": "<Module>",
  "action": "<Action>",
  "payload": { ... }
}
```

### レスポンス（成功）

```json
{
  "type": "module_response",
  "module": "<Module>",
  "action": "<Action>",
  "payload": { ... }
}
```

### レスポンス（エラー）

```json
{
  "type": "error",
  "code": "command_error",
  "message": "エラーメッセージ"
}
```

---

## メソッド一覧

### Organization

| メソッド | module | action | payload | 権限 | 戻り値 |
|----------|--------|--------|---------|------|--------|
| `Organization.List` | `organization` | `list` | _(なし)_ | 認証済み | `OrganizationResponse[]` |
| `Organization.Get` | `organization` | `get` | `{ organizationId: UUID }` | メンバー | `OrganizationResponse` |
| `Organization.Create` | `organization` | `create` | `{ name: string, slug: string, description?: string }` | 認証済み | `OrganizationResponse` |
| `Organization.Update` | `organization` | `update` | `{ organizationId: UUID, name: string, description?: string }` | admin/owner | `{ ok: true }` |
| `Organization.Delete` | `organization` | `delete` | `{ organizationId: UUID }` | owner | `{ ok: true }` |

#### OrganizationResponse

```typescript
{
  id: string
  name: string
  slug: string
  description: string
  createdBy: string
  createdAt: string  // ISO 8601
  updatedAt: string  // ISO 8601
}
```

---

### Member

| メソッド | module | action | payload | 権限 | 戻り値 |
|----------|--------|--------|---------|------|--------|
| `Member.List` | `member` | `list` | `{ organizationId: UUID }` | メンバー | `MemberResponse[]` |
| `Member.Add` | `member` | `add` | `{ organizationId: UUID, userId: UUID, role?: string }` | admin/owner | `{ ok: true }` |
| `Member.Update_role` | `member` | `update_role` | `{ organizationId: UUID, userId: UUID, role: string }` | admin/owner | `{ ok: true }` |
| `Member.Remove` | `member` | `remove` | `{ organizationId: UUID, userId: UUID }` | admin/owner（自分脱退は member 可） | `{ ok: true }` |

**role の値:** `owner` / `admin` / `member`

- `owner` ロールの付与は `Member.Update_role` で owner 自身のみ可能
- `Member.Add` では `owner` ロールを指定できない

#### MemberResponse

```typescript
{
  userId: string
  role: string
  joinedAt: string      // ISO 8601
  login: string
  displayName: string
  avatarUrl: string
  email: string | null
  lastLoginAt: string | null  // ISO 8601
}
```

---

### ProjectDefinition

| メソッド | module | action | payload | 権限 | 戻り値 |
|----------|--------|--------|---------|------|--------|
| `Project_definition.List` | `project_definition` | `list` | _(なし)_ | 認証済み | `ProjectDefinitionResponse[]` |
| `Project_definition.Get` | `project_definition` | `get` | `{ id: UUID }` | 認証済み | `ProjectDefinitionResponse` |
| `Project_definition.Create` | `project_definition` | `create` | `{ code: string, name: string, dataSchema?: object, commands?: array, pluginRepository?: string }` | system admin | `ProjectDefinitionResponse` |
| `Project_definition.Update` | `project_definition` | `update` | `{ id: UUID, name: string, dataSchema?: object, commands?: array, pluginRepository?: string }` | system admin | `{ ok: true }` |
| `Project_definition.Delete` | `project_definition` | `delete` | `{ id: UUID }` | system admin | `{ ok: true }` |

#### ProjectDefinitionResponse

```typescript
{
  id: string
  code: string              // プロジェクトコード (例: "ars", "schedula")
  name: string              // プロジェクト名
  dataSchema: object        // 保存するデータスキーマ
  commands: array            // 適用可能なコマンドリスト
  pluginRepository: string  // プラグインリポジトリ URL
  createdAt: string         // ISO 8601
  updatedAt: string         // ISO 8601
}
```

---

### OrganizationProject

| メソッド | module | action | payload | 権限 | 戻り値 |
|----------|--------|--------|---------|------|--------|
| `Org_project.List` | `org_project` | `list` | `{ organizationId: UUID }` | メンバー | `ProjectDefinitionResponse[]` |
| `Org_project.Enable` | `org_project` | `enable` | `{ organizationId: UUID, projectDefinitionId: UUID }` | admin/owner | `{ ok: true }` |
| `Org_project.Disable` | `org_project` | `disable` | `{ organizationId: UUID, projectDefinitionId: UUID }` | admin/owner | `{ ok: true }` |

---

### User

| メソッド | module | action | payload | 権限 | 戻り値 |
|----------|--------|--------|---------|------|--------|
| `User.Get` | `user` | `get` | `{ userId: UUID }` | 同一組織メンバー | `UserResponse` |

- 自分自身は常に取得可能
- 別組織のユーザーは取得不可 (`403 Forbidden`)

#### UserResponse

```typescript
{
  id: string
  githubId: number | null
  login: string
  displayName: string
  avatarUrl: string
  email: string | null
  role: string
  hasGoogleAuth: boolean
  hasPassword: boolean
  createdAt: string  // ISO 8601
  updatedAt: string  // ISO 8601
}
```

---

## 権限モデル

### システムレベル

| ロール | 説明 |
|--------|------|
| `admin` | 最初にログインしたユーザーに自動付与。プロジェクト定義の管理が可能。 |
| `general` | 通常ユーザー。 |

### 組織レベル

| ロール | 説明 |
|--------|------|
| `owner` | 組織作成者。組織の削除、ownership 移譲が可能。 |
| `admin` | メンバー管理、プロジェクト有効化/無効化、組織情報更新が可能。 |
| `member` | 組織内の情報閲覧のみ。自分自身の脱退は可能。 |

### 可視性ルール

- 組織メンバーは同じ組織内のメンバー情報（ログイン情報等）を閲覧可能
- 別の組織に属するメンバーの情報は参照不可
- ユーザーは複数の組織に同時に所属可能

---

## 操作ログ

全メソッド呼び出しは `operation_logs` テーブルに自動記録される。

```sql
operation_logs
├── id          UUID        -- ログ ID
├── user_id     UUID        -- 操作者
├── session_id  TEXT        -- WS セッション ID
├── method      TEXT        -- "Organization.Create" など
├── params      JSONB       -- 入力パラメータ
├── status      TEXT        -- "ok" / "error"
├── error       TEXT        -- エラー時のメッセージ
└── created_at  TIMESTAMPTZ -- 操作日時
```

インデックス: `user_id`, `session_id`, `method`, `created_at`
