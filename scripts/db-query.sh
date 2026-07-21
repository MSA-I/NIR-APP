#!/usr/bin/env bash
# Runs a SQL file against the Supabase project via the Management API.
# Usage: SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/db-query.sh <path-to-sql-file> [project-ref]
set -euo pipefail

DEFAULT_PROJECT_REF="rkftlbctohswhbbiaqin"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "שגיאה: SUPABASE_ACCESS_TOKEN לא מוגדר / Error: SUPABASE_ACCESS_TOKEN is not set" >&2
  echo "Usage: SUPABASE_ACCESS_TOKEN=sbp_... $0 <path-to-sql-file> [project-ref]" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "שגיאה: חסר נתיב לקובץ SQL / Error: missing path to SQL file" >&2
  echo "Usage: SUPABASE_ACCESS_TOKEN=sbp_... $0 <path-to-sql-file> [project-ref]" >&2
  exit 1
fi

SQL_FILE="$1"
PROJECT_REF="${2:-$DEFAULT_PROJECT_REF}"

if [[ ! -f "$SQL_FILE" || ! -r "$SQL_FILE" ]]; then
  echo "שגיאה: קובץ ה-SQL לא קיים או לא קריא: $SQL_FILE / Error: SQL file missing or unreadable: $SQL_FILE" >&2
  exit 1
fi

node -e 'process.stdout.write(JSON.stringify({query: require("fs").readFileSync(process.argv[1],"utf8")}))' "$SQL_FILE" \
  | curl -sS -f -X POST \
      "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary @-
echo
