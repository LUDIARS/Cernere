# プロジェクト管理設計

## 概要

Cernere は外部連携するプロジェクトを動的に登録・管理する。プロジェクトの追加・削除はコード変更なしにサービス実行中に行える。

## 原則

- プロジェクト定義は JSON (Zod バリデーション) で管理
- 登録はリンク (URL) または JSON 直接で行う
- 登録時の定義ファイルは履歴として保存され、バージョン管理される
- 削除は管理者のみ可能
- DB スキーマはプロジェクトごとに動的に生成
- テーブルの DROP は行わない（論理削除）
- カラムの追加はするが削除はしない

## YAML フォーマット

```yaml
# project-definition.yaml
project:
  key: "schedula"          # 英字始まり + 英数字/_/- (人が読むラベル、ユニーク。表名は決めない)
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

# 管理者が他プロジェクトへ許可する参照範囲
data_sharing:
  - project_key: "EducationLab"
    access: "read"
    columns:
      - major
      - student_id
    description: "EducationLabのプロフィール表示に必要な列だけを参照許可"

# 将来の拡張用
# webhooks:
#   events: [...]
```

### Managed Schemaのカラム共有

`data_sharing`はsystem adminがCernere管理画面から設定する。他プロジェクトの
project client自身は変更できない。

- `project_key`: 参照を許可する共有先
- `access`: `read`または`readwrite`
- `columns`: 参照・更新を許可するカラム名
- `modules`: 既存定義との互換用。指定時は`columns`との積集合だけを許可

`columns`を明示した場合は指定列だけを許可する。空配列はdeny-allとして扱う。
既存定義との互換性のため、`columns`を省略したgrantのみ従来どおりmodule範囲内の
全カラムを許可する。管理画面で保存すると、既存grantも現在選択されているカラムの
明示リストへ変換される。

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
    key             TEXT PRIMARY KEY,         -- 人が読むラベル (例: "schedula")、`^[A-Za-z][A-Za-z0-9_-]{1,62}$`
    storage_slug    TEXT NOT NULL UNIQUE,     -- project_data_<slug> を決める不変の SQL 識別子 (migration 043)
                                              -- `^[a-z][a-z0-9_]{1,49}$`、登録時に key から導出して固定
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
-- テーブル名: project_data_{storage_slug}  (key ではない。key を変えても表は動かない)
-- 例: project_data_schedula
CREATE TABLE project_data_{storage_slug} (
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
| `project` | `overview` | — | 認証済み |
| `project` | `register` | `{ yaml, url? }` | admin |
| `project` | `delete` | `{ key }` | admin |
| `project` | `update_schema` | `{ key, yaml }` | admin |

管理画面のManaged Schema Sharingでは、共有先・`read`/`readwrite`・許可カラムを
チェックボックスで指定する。保存はadmin専用`managed_project.update_schema`を使い、
プロジェクトWS経由のschema auto-syncに含まれる`data_sharing`は更新対象から除外して
現行値を保持する。応答の`adminOwnedFieldsPreserved`に`data_sharing`を含め、
サービス側から変更できないフィールドであることを明示する。

`list` / `overview` の戻り値には `frontendUrl: string | null` を含む。
これは `schema_definition.endpoint.frontend_url` を露出したもので、
Memoria Hub Shell が manifest probe (`<origin>/.well-known/ludiars-app.json`) するために使う。
詳細は [project-connection-registry.md](./project-connection-registry.md#ダッシュボードへの露出) 参照。

### ユーザーデータ操作

| module | action | payload | 権限 |
|--------|--------|---------|------|
| `project_data` | `get` | `{ projectKey, userId? }` | 認証済み (自分 or admin) |
| `project_data` | `set` | `{ projectKey, data }` | 認証済み (自分のみ) |

## マイグレーションロジック

#### SPEC-PROJECT-STORAGE-RESOLUTION

`managed_projects.storage_slug` が動的テーブル名の唯一の正本である。登録時は key から
安全な slug を導出し、既存 slug と衝突する場合は `_2`, `_3` の順で一意な値を発行する。
DB 行から表名を解決する全経路は、補間前に storage slug と完全な SQL 識別子を検証する。
project key 自体は SQL 識別子として検査・補間しない。

### プロジェクト登録時

1. YAML をパース・バリデーション
2. `managed_projects` にレコード挿入
3. `project_data_{storage_slug}` テーブルを CREATE IF NOT EXISTS
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
