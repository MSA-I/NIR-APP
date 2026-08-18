#!/usr/bin/env bash
#
# Builds and runs the OCR worker pool on a Linux host (written for a Hetzner Cloud VPS).
#
# The Linux twin of scripts/run-ocr-worker.ps1, and it exists for the same reason: before that
# script there was no committed way to start the production worker, so docker-compose.ocr.yml
# described an image tag that was not the one running and "is the fix deployed?" could only be
# answered by reading job timings out of the database.
#
# Secrets are read at run time from an env file outside the repository and are never printed,
# logged, or written back to disk.
#
# Usage:
#   ./scripts/run-ocr-worker.sh                 # 2 workers against production, image = HEAD
#   ./scripts/run-ocr-worker.sh --replicas 3
#   ./scripts/run-ocr-worker.sh --canary mistral   # replica 1 on mistral, the rest on --adapter
#   ./scripts/run-ocr-worker.sh --adapter mistral  # the whole pool on mistral
#   ./scripts/run-ocr-worker.sh --status        # report what is running, change nothing
#   ./scripts/run-ocr-worker.sh --stop          # stop the pool, change nothing else
#
# First-time setup on a fresh Hetzner box: see docs/OCR-WORKER-HOSTING.md
set -euo pipefail

REPLICAS=2
# The pool default and the optional single-replica canary. Kept separate because a canary is only
# evidence while something else is still running the old engine on the same queue.
ADAPTER="openai"
CANARY_ADAPTER=""
SUPABASE_URL_DEFAULT="https://rkftlbctohswhbbiaqin.supabase.co"
ENV_FILE="${OCR_ENV_FILE:-/etc/supplyflow/ocr.env}"
NAME_PREFIX="supplyflow-ocr-live"
TAG=""
ACTION="deploy"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --replicas) REPLICAS="$2"; shift 2 ;;
    --adapter)  ADAPTER="$2"; shift 2 ;;
    --canary)   CANARY_ADAPTER="$2"; shift 2 ;;
    --tag)      TAG="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --status)   ACTION="status"; shift ;;
    --stop)     ACTION="stop"; shift ;;
    -h|--help)  sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

# Prints settings, never credentials.
show_pool() {
  local names
  names="$(docker ps --filter "name=${NAME_PREFIX}" --format '{{.Names}}' || true)"
  if [ -z "$names" ]; then
    echo "No ${NAME_PREFIX} container is running."
    return 0
  fi
  while read -r name; do
    [ -n "$name" ] || continue
    local image settings
    image="$(docker inspect "$name" --format '{{.Config.Image}}')"
    settings="$(docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | grep -E '^(OCR_WORKER_ID|OCR_JOB_TIMEOUT_SECONDS|OCR_PAGE_CONCURRENCY|OCR_QA_PASSES)=' \
      | tr '\n' ' ')"
    echo "$name  $image  [${settings}]"
  done <<< "$names"
}

case "$ACTION" in
  status) show_pool; exit 0 ;;
  stop)
    existing="$(docker ps -aq --filter "name=${NAME_PREFIX}" || true)"
    if [ -n "$existing" ]; then
      # shellcheck disable=SC2086
      docker rm -f $existing >/dev/null
      echo "pool stopped."
    else
      echo "nothing to stop."
    fi
    exit 0
    ;;
esac

case "$REPLICAS" in
  ''|*[!0-9]*) die "--replicas must be a whole number" ;;
esac
[ "$REPLICAS" -ge 1 ] && [ "$REPLICAS" -le 8 ] || die "--replicas must be between 1 and 8"
for name in "$ADAPTER" ${CANARY_ADAPTER:+"$CANARY_ADAPTER"}; do
  case "$name" in
    openai|mistral) : ;;
    *) die "adapter must be openai or mistral, got: $name" ;;
  esac
done
if [ -n "$CANARY_ADAPTER" ] && [ "$REPLICAS" -lt 2 ]; then
  # A canary that is the entire pool is not a canary; it is a deploy without a control.
  die "--canary needs at least 2 replicas so one worker keeps running $ADAPTER"
fi

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (is your user in the docker group?)"

if [ -z "$TAG" ]; then
  TAG="$(git -C "$repo_root" rev-parse --short HEAD)" || die "could not resolve HEAD for the image tag"
fi
[ -n "$TAG" ] || die "empty image tag"
IMAGE="supplyflow-ocr-worker:${TAG}"

[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (see docs/OCR-WORKER-HOSTING.md)"
# A world-readable file holding an OpenAI key and a worker token is the whole attack. Refuse rather
# than warn: a warning in a deploy script is a line nobody reads twice.
perms="$(stat -c '%a' "$ENV_FILE")"
case "$perms" in
  600|400) : ;;
  *) die "$ENV_FILE has mode $perms; it must be 600 (run: chmod 600 $ENV_FILE)" ;;
esac

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${OCR_WORKER_TOKEN:?OCR_WORKER_TOKEN missing from $ENV_FILE}"
# Only the keys the configured adapters actually need. Demanding both would block a pool that has
# finished moving off one vendor.
case "$ADAPTER $CANARY_ADAPTER" in
  *openai*)  : "${OPENAI_API_KEY:?OPENAI_API_KEY missing from $ENV_FILE}" ;;
esac
case "$ADAPTER $CANARY_ADAPTER" in
  *mistral*) : "${MISTRAL_API_KEY:?MISTRAL_API_KEY missing from $ENV_FILE}" ;;
esac
SUPABASE_URL="${SUPABASE_URL:-$SUPABASE_URL_DEFAULT}"

echo "== Building $IMAGE"
docker build --tag "$IMAGE" "$repo_root/worker/ocr" >/dev/null

# Replace the whole pool rather than adding to it. Two generations of worker running at once is
# exactly the state that made a fixed 900-second ceiling look like it was still 300: half the jobs
# were being claimed by the old image.
existing="$(docker ps -aq --filter "name=${NAME_PREFIX}" || true)"
if [ -n "$existing" ]; then
  echo "== Removing $(echo "$existing" | wc -l) existing container(s) named ${NAME_PREFIX}*"
  # shellcheck disable=SC2086
  docker rm -f $existing >/dev/null
fi

for index in $(seq 1 "$REPLICAS"); do
  name="${NAME_PREFIX}-${index}"
  # The worker id is written into job leases, so it has to say which build and which replica. Two
  # workers sharing an id can renew each other's hold on a document, which is how a job goes
  # missing mid-flight -- and it is why `docker compose up --scale` is not enough here.
  # Replica 1 carries the canary when one is asked for; every other replica runs the pool default.
  if [ "$index" = "1" ] && [ -n "$CANARY_ADAPTER" ]; then
    adapter="$CANARY_ADAPTER"
  else
    adapter="$ADAPTER"
  fi
  # The engine is part of the worker id because the id is what job leases record. Without it a
  # canary produces two populations of documents that cannot be told apart afterwards, which is
  # the one thing a canary exists to do.
  worker_id="supplyflow-${TAG}-${index}-${adapter}"
  docker run --detach --name "$name" \
    --init --restart unless-stopped --stop-timeout 45 \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 256 \
    --tmpfs /var/tmp/supplyflow-ocr:rw,noexec,nosuid,nodev,size=512m,mode=0700,uid=10001,gid=10001 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001 \
    --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
    --env "SUPABASE_URL=${SUPABASE_URL}" \
    --env "OCR_WORKER_TOKEN=${OCR_WORKER_TOKEN}" \
    --env "OPENAI_API_KEY=${OPENAI_API_KEY:-}" \
    --env "MISTRAL_API_KEY=${MISTRAL_API_KEY:-}" \
    --env "OCR_WORKER_ID=${worker_id}" \
    --env "OCR_ADAPTER=${adapter}" \
    --env "OCR_OPENAI_MODEL=${OCR_OPENAI_MODEL:-gpt-5.6-terra}" \
    --env "OCR_QA_PASSES=${OCR_QA_PASSES:-3}" \
    --env "OCR_PAGE_CONCURRENCY=${OCR_PAGE_CONCURRENCY:-3}" \
    --env "OCR_JOB_TIMEOUT_SECONDS=${OCR_JOB_TIMEOUT_SECONDS:-900}" \
    --env "OCR_TEMP_ROOT=/var/tmp/supplyflow-ocr" \
    "$IMAGE" >/dev/null
  echo "Started $name as $worker_id (adapter: $adapter)"
done

# Read the settings back off the running containers instead of repeating what was requested. The
# whole reason this script exists is that "we set it to 900" and "it is running with 900" turned
# out to be different claims.
echo
echo "Running pool:"
show_pool

cat <<'NEXT'

Next, in order:
  1. Confirm the pool claimed work: docker logs --tail 20 supplyflow-ocr-live-1
  2. Upload a document on the live site and watch it reach "מוכן לבדיקה".
  3. ONLY THEN stop the workers on any other machine. Two pools against one project
     will fight over the same jobs.
NEXT
