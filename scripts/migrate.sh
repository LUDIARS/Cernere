#!/bin/bash
# 手動マイグレーション実行スクリプト
#
# Usage:
#   ./scripts/migrate.sh                    # Docker コンテナの DB に全マイグレーション適用
#   ./scripts/migrate.sh 010_managed_projects  # 特定バージョンのみ適用
#   ./scripts/migrate.sh --status           # 適用状況を表示
#   ./scripts/migrate.sh --reset VERSION    # 特定バージョンを未適用に戻す (SQLは実行しない)
#
# 環境変数:
#   PGHOST, PGPORT, PGUSER, PGDATABASE で接続先を変更可能

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../migrations"
CONTAINER_NAME="${CONTAINER_NAME:-cernere-postgres}"

# デフォルト接続情報
PGUSER="${PGUSER:-cernere}"
PGDATABASE="${PGDATABASE:-cernere}"

run_sql() {
  docker exec "$CONTAINER_NAME" psql -U "$PGUSER" -d "$PGDATABASE" -t -A -c "$1" 2>/dev/null
}

run_sql_file() {
  docker exec -i "$CONTAINER_NAME" psql -U "$PGUSER" -d "$PGDATABASE" < "$1"
}

# _migrations テーブル確保
run_sql "CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())" > /dev/null

case "${1:-}" in
  --status)
    echo "=== Migration Status ==="
    echo ""
    echo "Applied:"
    run_sql "SELECT version, applied_at FROM _migrations ORDER BY version" | while IFS='|' read -r ver ts; do
      printf "  %-40s %s\n" "$ver" "$ts"
    done
    echo ""
    echo "Pending:"
    applied=$(run_sql "SELECT version FROM _migrations" | tr '\n' '|')
    for file in "$MIGRATIONS_DIR"/*.sql; do
      [ -f "$file" ] || continue
      version="$(basename "$file" .sql)"
      if ! echo "$applied" | grep -q "$version"; then
        echo "  $version"
      fi
    done
    ;;

  --reset)
    version="${2:?Usage: migrate.sh --reset VERSION}"
    echo "Removing migration record: $version"
    run_sql "DELETE FROM _migrations WHERE version = '$version'"
    echo "Done. Run migrate.sh to re-apply."
    ;;

  "")
    # 全マイグレーション適用
    applied=$(run_sql "SELECT version FROM _migrations" | tr '\n' '|')
    count=0

    for file in "$MIGRATIONS_DIR"/*.sql; do
      [ -f "$file" ] || continue
      version="$(basename "$file" .sql)"

      if echo "$applied" | grep -q "$version"; then
        continue
      fi

      echo "[migrate] Applying: $(basename "$file")"
      if run_sql_file "$file"; then
        run_sql "INSERT INTO _migrations (version) VALUES ('$version')" > /dev/null
        count=$((count + 1))
      else
        echo "[migrate] FAILED: $(basename "$file")"
        exit 1
      fi
    done

    if [ "$count" -gt 0 ]; then
      echo "[migrate] Applied $count migration(s)"
    else
      echo "[migrate] All migrations already applied"
    fi
    ;;

  *)
    # 特定バージョンのみ適用
    version="$1"
    file="$MIGRATIONS_DIR/${version}.sql"

    if [ ! -f "$file" ]; then
      echo "Migration file not found: $file"
      exit 1
    fi

    existing=$(run_sql "SELECT version FROM _migrations WHERE version = '$version'")
    if [ -n "$existing" ]; then
      echo "Already applied: $version (use --reset to re-apply)"
      exit 0
    fi

    echo "[migrate] Applying: $version"
    run_sql_file "$file"
    run_sql "INSERT INTO _migrations (version) VALUES ('$version')" > /dev/null
    echo "[migrate] Done."
    ;;
esac
