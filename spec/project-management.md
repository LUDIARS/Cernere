# プロジェクト管理設計

## 概要

Cernere は外部連携するプロジェクトを動的に登録・管理する。プロジェクトの追加・削除はコード変更なしにサービス実行中に行える。

## 原則

- プロジェクト定義は YAML ファイルで管理
- 登録はリンク (URL) またはファイルアップロードで行う
- 削除は管理者のみ可能
- DB スキーマはプロジェクトごとに動的に生成
- テーブルの DROP は行わない（論理削除）
- カラムの追加はするが削除はしない

## YAML フォーマット

```yaml
# project-definition.yaml
project:
  key: "schedula"          # 英数字のみ (DBスキーマキー、ユニーク)
  name: "Schedula"         # 表示名 (自由入力)
  description: "学校スケジューリング & 予約プラットフォーム"

# ユーザーデータの DB スキーマ定義
user_data:
  columns:
    major:
      type: text
      nullable: true
      description: "学科・専攻"
    calendar_access_id:
      type: text
      nullable: true
      description: "Google Calendar 連携 ID"
    student_id:
      type: text
      nullable: true
      description: "学籍番号"

# 将来の拡張用
# permissions:
#   scopes: [...]
# webhooks:
#   events: [...]
```

### カラム型

| YAML 型 | PostgreSQL 型 |
|---------|---------------|
| `text` | TEXT |
| `integer` | INTEGER |
| `bigint` | BIGINT |
| `boolean` | BOOLEAN |
| `timestamp` | TIMESTAMPTZ |
| `json` | JSONB |
| `uuid` | UUID |

## DB 設計

### プロジェクト管理テーブル

```sql
-- プロジェクト登録情報
CREATE TABLE managed_projects (
    key             TEXT PRIMARY KEY,         -- 英数字のみ (例: "schedula")
    name            TEXT NOT NULL,            -- 表示名
    description     TEXT NOT NULL DEFAULT '',
    client_id       TEXT NOT NULL UNIQUE,     -- 認証用キー
    client_secret_hash TEXT NOT NULL,         -- 認証用シークレット (bcrypt)
    schema_definition JSONB NOT NULL,         -- YAML から変換したスキーマ定義
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- プロジェクト別ユーザーデータ (動的テーブル)
-- テーブル名: project_data_{key}
-- 例: project_data_schedula
CREATE TABLE project_data_{key} (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 以下は schema_definition に基づいて動的生成
    {column_name}   {column_type},
    ...
    _deleted_columns JSONB NOT NULL DEFAULT '{}',  -- 論理削除されたカラム値
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)
);
```

### リレーション用キー

各プロジェクトデータテーブルは `user_id` で `users` テーブルとリレーションする。追加のリレーション用 DB キー名は `managed_projects` の `schema_definition` 内で定義可能。

## API

### REST エンドポイント

| メソッド | パス | 権限 | 説明 |
|---------|------|------|------|
| POST | `/api/projects/register` | admin | YAML ファイル/URL でプロジェクト登録 |
| GET | `/api/projects` | 認証済み | プロジェクト一覧 |
| GET | `/api/projects/:key` | 認証済み | プロジェクト詳細 |
| DELETE | `/api/projects/:key` | admin | プロジェクト論理削除 (is_active=false) |
| PUT | `/api/projects/:key/schema` | admin | スキーマ更新 (カラム追加のみ) |

### WS コマンド

| module | action | payload | 権限 |
|--------|--------|---------|------|
| `project` | `list` | — | 認証済み |
| `project` | `get` | `{ key }` | 認証済み |
| `project` | `register` | `{ yaml, url? }` | admin |
| `project` | `delete` | `{ key }` | admin |
| `project` | `update_schema` | `{ key, yaml }` | admin |

### ユーザーデータ操作

| module | action | payload | 権限 |
|--------|--------|---------|------|
| `project_data` | `get` | `{ projectKey, userId? }` | 認証済み (自分 or admin) |
| `project_data` | `set` | `{ projectKey, data }` | 認証済み (自分のみ) |

## マイグレーションロジック

### プロジェクト登録時

1. YAML をパース・バリデーション
2. `managed_projects` にレコード挿入
3. `project_data_{key}` テーブルを CREATE IF NOT EXISTS
4. YAML のカラム定義に従いカラムを追加 (既存カラムはスキップ)

### スキーマ更新時

1. 新しい YAML をパース
2. 既存テーブルと比較
3. 新規カラムのみ ADD COLUMN
4. 削除されたカラムは `schema_definition` 内で `_deleted: true` フラグを付与
5. 実テーブルのカラムは残す (データ保全)

### プロジェクト削除時

1. `managed_projects.is_active = false` に更新
2. テーブルは DROP しない
3. 再登録時はテーブルを再利用
