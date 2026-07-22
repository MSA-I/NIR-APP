#!/usr/bin/env bash
# Runs a SQL file against an explicitly named Supabase project via the Management API.
# Usage: SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/db-query.sh <sql-file> <project-ref>
set -euo pipefail

KNOWN_PRODUCTION_REF="rkftlbctohswhbbiaqin"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "Error: SUPABASE_ACCESS_TOKEN is not set" >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Error: SQL file and explicit project ref are required" >&2
  echo "Usage: SUPABASE_ACCESS_TOKEN=sbp_... $0 <sql-file> <project-ref>" >&2
  exit 1
fi

SQL_FILE="$1"
PROJECT_REF="$2"

if [[ "$PROJECT_REF" == "$KNOWN_PRODUCTION_REF" && "${SUPABASE_ALLOW_PRODUCTION:-}" != "1" ]]; then
  echo "Refusing to run SQL against the known production project without SUPABASE_ALLOW_PRODUCTION=1" >&2
  exit 1
fi

if [[ ! "$PROJECT_REF" =~ ^[a-z0-9]{20}$ ]]; then
  echo "Error: project ref must contain exactly 20 lowercase letters or digits" >&2
  exit 1
fi

if [[ ! -f "$SQL_FILE" || ! -r "$SQL_FILE" ]]; then
  echo "Error: SQL file missing or unreadable: $SQL_FILE" >&2
  exit 1
fi

node -e 'process.stdout.write(JSON.stringify({query: require("fs").readFileSync(process.argv[1],"utf8")}))' "$SQL_FILE" \
  | curl -sS -f -X POST \
      "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary @-
echo
