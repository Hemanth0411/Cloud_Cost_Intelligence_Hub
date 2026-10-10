#!/usr/bin/env bash
# Cloud Cost Intelligence Hub -- operator script.
#
# The real implementation; the Makefile just delegates here, because the
# dev machine is Windows and has no `make`. Runs in Git Bash.
#
#   ./do.sh build
#   ./do.sh up       dev
#   ./do.sh migrate  dev
#   ./do.sh outputs  dev
#   ./do.sh teardown dev     # backup -> verify -> destroy -> prove
#   ./do.sh restore  dev backups/dev-....sql
#   ./do.sh sweep    dev     # proves a teardown was complete
#
# An environment argument is required on every env-scoped command. There
# is deliberately no default: defaulting is how the wrong one gets
# destroyed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PROJECT="costhub"
BACKEND="backend"
DIST="dist"
BUNDLE="$DIST/lambda.zip"
BACKUPS="backups"
TF="terraform -chdir=terraform"
REGION="us-east-1"

# State a human created. Facts are NOT backed up: they are re-ingested
# from Cost Explorer, which is faster than moving them and proves the
# pipeline works wherever it lands next.
APP_TABLES=(users identities access_grants cloud_connections
            alert_rules alert_events anomaly_findings audit_log)

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

need_env() {
  [ -n "${1:-}" ] || die "environment required: ./do.sh $CMD dev|staging|main"
  case "$1" in
    dev|staging|main) ;;
    *) die "unknown environment '$1' (dev|staging|main)" ;;
  esac
  ENV="$1"
  [ -f "terraform/env/$ENV.tfvars" ] || die "missing terraform/env/$ENV.tfvars"
}

select_workspace() {
  terraform -chdir=terraform workspace select -or-create "$ENV" >/dev/null
  echo "workspace: $ENV"
}

db_url() { terraform -chdir=terraform output -raw database_url; }

# -------------------------------------------------------------- build

cmd_build() {
  step "packaging $BUNDLE"
  rm -rf "$DIST/build" "$BUNDLE"
  mkdir -p "$DIST/build"

  # Linux wheels for the Lambda runtime, built from Windows.
  # --only-binary is not optional: anything needing a compiler would
  # otherwise silently build for the wrong platform and fail at runtime.
  python -m pip install -q \
    --platform manylinux2014_x86_64 \
    --implementation cp --python-version 3.11 \
    --only-binary=:all: --upgrade \
    -r "$BACKEND/requirements.txt" -t "$DIST/build"

  cp -r "$BACKEND/costhub" "$DIST/build/costhub"

  # boto3/botocore ship with the Lambda python3.11 runtime, so bundling
  # them wastes ~22MB and risks shadowing the runtime's version with an
  # older pinned one. The local venv still needs them for the CLI.
  rm -rf "$DIST/build"/{boto3,botocore,s3transfer}* 2>/dev/null || true

  find "$DIST/build" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DIST/build" -name 'tests' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DIST/build" -name '*.dist-info' -type d -prune -exec rm -rf {} + 2>/dev/null || true

  ( cd "$DIST/build" && python -c "import shutil; shutil.make_archive('../lambda','zip','.')" )
  echo "built $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
}

cmd_test() { ( cd "$BACKEND" && python -m pytest tests/ -q ); }

# ----------------------------------------------------------------- up

cmd_up() {
  need_env "${1:-}"
  cmd_build
  select_workspace
  step "terraform apply ($ENV)"
  $TF apply -var-file="env/$ENV.tfvars"
  cmd_migrate "$ENV"
  cmd_outputs "$ENV"
}

cmd_migrate() {
  need_env "${1:-}"
  select_workspace
  step "migrations ($ENV)"
  ( cd "$BACKEND" && DATABASE_URL="$(db_url)" python -m costhub.migrate )
}

cmd_outputs() {
  need_env "${1:-}"
  select_workspace
  mkdir -p frontend
  local out="frontend/.env.$ENV"
  {
    echo "VITE_API_BASE_URL=$($TF output -raw api_url)"
    echo "VITE_COGNITO_USER_POOL_ID=$($TF output -raw cognito_user_pool_id)"
    echo "VITE_COGNITO_CLIENT_ID=$($TF output -raw cognito_client_id)"
    echo "VITE_COGNITO_DOMAIN=$($TF output -raw cognito_domain)"
    echo "VITE_AWS_REGION=$REGION"
    echo "VITE_USE_MOCK=false"
  } > "$out"
  step "wrote $out"
  cat "$out"
  echo
  echo "frontend: $($TF output -raw frontend_url)"
  echo "api:      $($TF output -raw api_url)"
}

# ----------------------------------------------------------- teardown

dump_to() {
  local out="$1"
  local args=()
  for t in "${APP_TABLES[@]}"; do args+=(-t "$t"); done
  pg_dump "$(db_url)" --data-only --no-owner --column-inserts "${args[@]}" > "$out"
}

cmd_export_data() {
  need_env "${1:-}"
  select_workspace
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/$ENV-$(date -u +%Y%m%dT%H%M%SZ).sql"
  step "backup ($ENV)"
  dump_to "$out"
  echo "wrote $out ($(wc -l < "$out") lines)"
}

cmd_teardown() {
  need_env "${1:-}"
  select_workspace
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/$ENV-$(date -u +%Y%m%dT%H%M%SZ).sql"

  step "1/4 backup"
  dump_to "$out"
  echo "    $out ($(wc -l < "$out") lines)"

  step "2/4 verify"
  # The whole reason teardown is a command rather than a raw destroy: a
  # failed dump plus -auto-approve silently loses every grant and the
  # entire audit trail.
  if ! grep -q 'INSERT INTO .*users' "$out"; then
    if [ "${FORCE:-}" = "1" ]; then
      echo "    WARNING: backup has no users; continuing because FORCE=1"
    else
      die "backup $out contains no users. Destroying now would lose every
       grant and the whole audit trail. Fix the dump, or re-run with
       FORCE=1 if the database is genuinely empty."
    fi
  else
    echo "    backup contains user rows: ok"
  fi

  step "3/4 destroy ($ENV only -- this workspace cannot reach the others)"
  $TF destroy -var-file="env/$ENV.tfvars" -auto-approve

  step "4/4 prove"
  cmd_sweep "$ENV"
}

cmd_sweep() {
  need_env "${1:-}"
  step "resources still tagged Project=$PROJECT,Environment=$ENV"
  local left
  left="$(aws resourcegroupstaggingapi get-resources --region "$REGION" \
    --tag-filters "Key=Project,Values=$PROJECT" "Key=Environment,Values=$ENV" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null \
    | tr '\t' '\n' | sed '/^$/d' || true)"

  if [ -z "$left" ]; then
    echo "    none -- teardown complete"
  else
    echo "$left" | sed 's/^/    /'
    echo
    echo "    Anything listed was created outside Terraform, or a teardown"
    echo "    flag is missing. SES identities and cross-account roles are"
    echo "    expected to survive; see docs/13."
  fi
}

cmd_restore() {
  need_env "${1:-}"
  local file="${2:-}"
  [ -n "$file" ] || die "usage: ./do.sh restore $ENV backups/$ENV-....sql"
  [ -f "$file" ] || die "no such backup: $file"

  cmd_up "$ENV"
  step "restoring $file"
  psql "$(db_url)" -v ON_ERROR_STOP=1 -f "$file"
  echo
  echo "restored. Two things are NOT covered:"
  echo "  * facts -- run the ingest Lambda to refetch from Cost Explorer"
  echo "  * SES recipient verification is per-account; re-verify, or"
  echo "    nobody can receive a login code"
}

cmd_help() {
  # Print the header comment block, stopping at the first non-comment line.
  sed -n '2,/^[^#]/p' "$0" | sed '$d' | sed 's/^#\{1,\} \{0,1\}//'
}

CMD="${1:-help}"
shift || true
case "$CMD" in
  build)       cmd_build ;;
  test)        cmd_test ;;
  up)          cmd_up "$@" ;;
  migrate)     cmd_migrate "$@" ;;
  outputs)     cmd_outputs "$@" ;;
  export-data) cmd_export_data "$@" ;;
  teardown)    cmd_teardown "$@" ;;
  sweep)       cmd_sweep "$@" ;;
  restore)     cmd_restore "$@" ;;
  help|-h|--help) cmd_help ;;
  *)           die "unknown command '$CMD' (run ./do.sh help)" ;;
esac
