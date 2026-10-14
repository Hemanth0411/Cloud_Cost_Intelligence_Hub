#!/usr/bin/env bash
# Cloud Cost Intelligence Hub -- operator script.
#
# The real implementation; the Makefile just delegates here, because the
# dev machine is Windows and has no `make`. Runs in Git Bash.
#
#   ./do.sh build
#   ./do.sh up       dev
#   ./do.sh migrate  dev
#   ./do.sh cli      dev backfill --months 14
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
BRANDING="branding"
# Absolute, not relative: `db_url` is called from inside `cd backend`
# subshells, where a relative -chdir would resolve to backend/terraform.
# The path handed to terraform.exe must be a WINDOWS path.
#
# Git Bash normally rewrites a POSIX argument like /c/DFIQ/... into
# C:/DFIQ/... on the way to a native binary. `MSYS_NO_PATHCONV=1`
# switches that off -- and it has to be set for some aws commands
# (an IAM --path-prefix of "/costhub/" would otherwise become
# "C:/Program Files/Git/costhub/"), which this script sets per-call.
#
# But a user who exports it for their whole shell broke every terraform
# call here:
#
#   Error handling -chdir option: chdir /c/DFIQ/.../terraform:
#   The system cannot find the path specified.
#
# cygpath -m resolves it explicitly instead of relying on the
# conversion, so the script behaves the same either way.
TF_DIR="$ROOT/terraform"
if command -v cygpath >/dev/null 2>&1; then
  TF_DIR="$(cygpath -m "$TF_DIR")"
fi
TF="terraform -chdir=$TF_DIR"
REGION="us-east-1"

# State a human created. Facts are NOT backed up: they are re-ingested
# from Cost Explorer, which is faster than moving them and proves the
# pipeline works wherever it lands next.
#
# ORDER IS LOAD-BEARING. pg_dump emits TABLE DATA alphabetically, not in
# -t order, so a single dump puts access_grants and alert_events before
# users and the first INSERT violates a foreign key. Dumping per table in
# dependency order and concatenating is the fix that needs no superuser.
APP_TABLES=(users identities access_grants cloud_connections
            alert_rules alert_events anomaly_findings audit_log)

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# Same problem as TF_DIR above: an `aws --settings file://...` argument
# is handed to a native binary, so it needs a WINDOWS path, and relying
# on Git Bash to rewrite it breaks for anyone who has exported
# MSYS_NO_PATHCONV=1. cygpath resolves it explicitly instead. Relative
# arguments are anchored to $ROOT, which is where this script cds to.
winpath() {
  local p="$1"
  case "$p" in /* | [A-Za-z]:*) ;; *) p="$ROOT/$p" ;; esac
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; else printf '%s' "$p"; fi
}

# The backup-before-destroy guard is only as good as the tools it calls.
# Neither pg_dump nor psql ships with the AWS CLI or with Git for
# Windows, and on this machine neither was on PATH -- so `teardown`
# would have reached the destroy with an empty dump file, and the "is
# there a users row?" check would have been the thing that caught it,
# by accident, with a confusing message. Fail early and say what to
# install instead.
#
# Version note: pg_dump refuses to dump a server newer than itself, so
# the client needs to be >= the Postgres major version in use (Neon is
# 17 at the time of writing).
# Same class of bug as need_pg, found the same way -- by `up` reaching
# the migration step and dying on an import. `do.sh` calls bare `python`,
# so it inherits whatever is on PATH, and an activated virtualenv
# belonging to a DIFFERENT project shadows the interpreter that actually
# has the dependencies. The apply had already succeeded by then, so the
# deploy was left half-done: infrastructure up, schema absent.
need_python_deps() {
  python -c "import psycopg" 2>/dev/null && return 0
  die "the active python cannot import psycopg.

       Using: $(python -c "import sys; print(sys.executable)" 2>/dev/null || echo "python not found")

       This is usually an activated virtualenv from another project
       shadowing the interpreter that has the dependencies. Either:
         deactivate
       or install them where you are:
         python -m pip install -r backend/requirements.txt"
}

need_pg() {
  local missing=()
  command -v pg_dump >/dev/null 2>&1 || missing+=(pg_dump)
  command -v psql    >/dev/null 2>&1 || missing+=(psql)
  [ ${#missing[@]} -eq 0 ] && return 0
  die "missing: ${missing[*]}

       These come with the PostgreSQL client tools, which are NOT part of
       the AWS CLI or Git for Windows. Install them and reopen the shell:

         winget install PostgreSQL.PostgreSQL.17
         # then add C:\\Program Files\\PostgreSQL\\17\\bin to PATH

       Nothing has been changed. Without these, a teardown cannot take
       the backup it promises and a restore cannot replay one."
}

need_env() {
  [ -n "${1:-}" ] || die "environment required: ./do.sh $CMD dev|staging|main"
  case "$1" in
    dev|staging|main) ;;
    *) die "unknown environment '$1' (dev|staging|main)" ;;
  esac
  ENV="$1"
  [ -f "terraform/env/$ENV.tfvars" ] || die "missing terraform/env/$ENV.tfvars"
}

# Terraform has allowed_account_ids, which is the real guard. This is the
# same check a step earlier, because do.sh also calls `aws` directly
# (branding, the sweep probes) and because "you are pointed at the wrong
# account" is worth saying in one line rather than as a provider error.
check_account() {
  local want have
  want="$(grep -E '^[[:space:]]*aws_account_id' "terraform/env/$ENV.tfvars" \
          | head -1 | cut -d'"' -f2)"
  [ -n "$want" ] || die "aws_account_id is not set in terraform/env/$ENV.tfvars
       Run: aws sts get-caller-identity --query Account --output text"

  have="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || die "no usable AWS credentials. Set AWS_PROFILE, or run aws configure."

  [ "$want" = "$have" ] || die "wrong AWS account.
       $ENV.tfvars expects : $want
       your credentials are: $have

       Nothing has been changed. Point AWS_PROFILE at the right account:
         AWS_PROFILE=costhub ./do.sh $CMD $ENV"

  # Reused by cmd_outputs for NEXT_PUBLIC_DEPLOY_ACCOUNT_ID. Taken from
  # the verified credentials rather than a terraform output, so reading
  # it never touches the local state file -- which is single-writer and
  # does get locked by a concurrent apply.
  ACCOUNT_ID="$have"
  echo "account:   $have"
}

select_workspace() {
  check_account
  $TF workspace select -or-create "$ENV" >/dev/null
  echo "workspace: $ENV"
}

# Uses the absolute $TF: this is called from inside `cd backend`
# subshells, where a relative -chdir would resolve to backend/terraform.
db_url() { $TF output -raw database_url; }
superadmin_email() { $TF output -raw superadmin_email; }

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

  # *.dist-info IS NOT DEAD WEIGHT. Stripping it used to be the next line
  # here, and it killed the API outright:
  #
  #   No package metadata was found for email-validator
  #   PackageNotFoundError ... fastapi/openapi/models.py -> pydantic
  #
  # pydantic asks importlib.metadata for email-validator's version when
  # it builds the EmailStr schema, and importlib.metadata reads exactly
  # the directory that was being deleted. The package itself was present;
  # only its metadata was gone. So `from fastapi import FastAPI` raised
  # at import time, every request to the Function URL failed, and nothing
  # in terraform or the build output said anything was wrong -- the zip
  # built, uploaded and reported success.
  #
  # The saving was under a megabyte. Any dependency may read its own
  # metadata, so none of it is safe to remove.

  ( cd "$DIST/build" && python -c "import shutil; shutil.make_archive('../lambda','zip','.')" )
  echo "built $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
}

cmd_test() { ( cd "$BACKEND" && python -m pytest tests/ -q ); }

# ----------------------------------------------------------------- up

cmd_up() {
  need_python_deps
  need_env "${1:-}"
  cmd_build
  select_workspace
  step "terraform apply ($ENV)"
  $TF apply -var-file="env/$ENV.tfvars"
  ensure_login_branding
  cmd_migrate "$ENV"
  cmd_outputs "$ENV"
}

ensure_login_branding() {
  # Managed Login v2 needs a branding style, and AWS is explicit that
  # creating an app client programmatically leaves it WITHOUT one -- the
  # console adds a default, the API does not. With no branding the hosted
  # login page does not work, which means nobody can sign in.
  #
  # aws_cognito_managed_login_branding does not exist in the pinned aws
  # provider (verified: 14 cognito resources in 5.100.0, not that one),
  # so this is scripted here rather than declared. It is idempotent and
  # visible, which is the next best thing to being in Terraform.
  #
  # What it applies is CostHub's own palette and logo rather than AWS's
  # defaults, because this page is the one screen of the product that
  # AWS renders: sign-in leaves the app for a cognito domain, and in the
  # default skin the user is looking at a different product mid-flow.
  # The redirect itself cannot be removed -- passwordless email OTP
  # requires managed login -- so styling it is the whole fix. Colours,
  # radii and assets live in branding/; see branding/README.md.
  local pool client style tmp f
  pool="$($TF output -raw cognito_user_pool_id)"
  client="$($TF output -raw cognito_client_id)"

  for f in managed-login-settings.json costhub-header-logo.png \
           costhub-favicon.ico costhub-email-graphic.svg; do
    [ -f "$BRANDING/$f" ] || die "missing $BRANDING/$f

       All four are committed, so the first move is to restore it:
         git checkout -- branding/$f

       Only the logo and the favicon can be redrawn
       (python branding/make-assets.py). The settings document and the
       email graphic are written by hand and have no generator."
  done

  tmp="$(mktemp -d)"
  # Explicitly, not on set -e: an unreadable asset here would otherwise
  # abort with nothing but base64's message, leaving the temp dir behind
  # and never saying that the login page is what just broke.
  branding_assets >"$tmp/assets.json" \
    || branding_died "encoding the branding assets" "$tmp"

  # Two paths because the API has two, and create fails on a client that
  # already has a style. Both end at the same settings, so re-running
  # `up` converges rather than erroring.
  if style="$(aws cognito-idp describe-managed-login-branding-by-client \
                --user-pool-id "$pool" --client-id "$client" \
                --region "$REGION" \
                --query 'ManagedLoginBranding.ManagedLoginBrandingId' \
                --output text 2>"$tmp/describe.err")" \
     && [ -n "$style" ] && [ "$style" != "None" ]; then
    step "updating managed login branding ($style)"
    aws cognito-idp update-managed-login-branding \
      --user-pool-id "$pool" --managed-login-branding-id "$style" \
      --settings "file://$(winpath "$BRANDING/managed-login-settings.json")" \
      --assets "file://$(winpath "$tmp/assets.json")" \
      --region "$REGION" >/dev/null \
      || branding_died UpdateManagedLoginBranding "$tmp"
    echo "login branding: updated"
  else
    # Only "there is no style yet" may fall through to create, so that a
    # missing permission is not read as absence and reported as the wrong
    # problem. It does not separate out a wrong pool id: Cognito answers
    # ResourceNotFoundException for that too (verified), so that case
    # falls through and fails on the create instead -- loudly, and with
    # the real AWS message, which names the pool.
    grep -q 'ResourceNotFoundException' "$tmp/describe.err" 2>/dev/null || {
      echo "could not read managed login branding:" >&2
      cat "$tmp/describe.err" >&2
      rm -rf "$tmp"
      die "login branding not verifiable"
    }
    step "creating managed login branding (not expressible in the pinned provider)"
    aws cognito-idp create-managed-login-branding \
      --user-pool-id "$pool" --client-id "$client" \
      --settings "file://$(winpath "$BRANDING/managed-login-settings.json")" \
      --assets "file://$(winpath "$tmp/assets.json")" \
      --region "$REGION" >/dev/null \
      || branding_died CreateManagedLoginBranding "$tmp"
    echo "login branding: created"
  fi

  rm -rf "$tmp"
}

# base64 of each committed asset, as the --assets document.
#
# ColorMode is required per asset. colorSchemeMode is pinned to LIGHT in
# managed-login-settings.json, but both modes are supplied so that
# switching it later does not leave AWS's default artwork behind. The
# whole request must stay under 2MB; these are ~20KB.
branding_assets() {
  # Two deliberate things here, and a probe that failed before both were:
  #
  #   `local logo="$(base64 ...)"` would return the exit status of
  #   `local`, which is always 0, so a failing base64 would be swallowed
  #   and an empty "Bytes" uploaded. Hence declare first, assign after.
  #
  #   `|| return 1` rather than leaning on set -e, because the caller
  #   invokes this as `branding_assets || branding_died`, and set -e is
  #   suppressed inside a command on the left of `||` -- the failing
  #   assignment would carry on to the cat below and the function would
  #   return 0 having written an empty document. It did, until this.
  local logo favicon email
  logo="$(base64 -w0 "$BRANDING/costhub-header-logo.png")"        || return 1
  favicon="$(base64 -w0 "$BRANDING/costhub-favicon.ico")"         || return 1
  email="$(base64 -w0 "$BRANDING/costhub-email-graphic.svg")"     || return 1
  cat <<ASSETS
[
  {"Category":"PAGE_HEADER_LOGO","ColorMode":"LIGHT","Extension":"PNG","Bytes":"$logo"},
  {"Category":"PAGE_HEADER_LOGO","ColorMode":"DARK","Extension":"PNG","Bytes":"$logo"},
  {"Category":"FAVICON_ICO","ColorMode":"LIGHT","Extension":"ICO","Bytes":"$favicon"},
  {"Category":"FAVICON_ICO","ColorMode":"DARK","Extension":"ICO","Bytes":"$favicon"},
  {"Category":"EMAIL_GRAPHIC","ColorMode":"LIGHT","Extension":"SVG","Bytes":"$email"},
  {"Category":"EMAIL_GRAPHIC","ColorMode":"DARK","Extension":"SVG","Bytes":"$email"}
]
ASSETS
}

# Not a warning. Without a branding style the managed login page does not
# render at all, so a successful-looking `up` would hand over a deployment
# nobody can sign in to.
branding_died() {
  local op="$1" tmp="$2"
  rm -rf "$tmp"
  echo "$op failed -- the login page may not render, and nobody can sign in." >&2
  echo "  The real error is above. If it came from AWS, check these first:" >&2
  echo "  cognito-idp:CreateManagedLoginBranding, cognito-idp:UpdateManagedLoginBranding," >&2
  echo "  cognito-idp:DescribeManagedLoginBranding." >&2
  echo "  Then re-run: ./do.sh up $ENV" >&2
  die "login branding not applied"
}

# The deployed DATABASE_URL, read from the API Lambda rather than from
# Terraform state. Two reasons, and the second one is why this exists:
#
#  1. It is the value the deployed app actually uses. Terraform state is
#     what we asked for; this is what is running.
#  2. The state file is a LOCAL file with no lock server (trap 11), so
#     `terraform output` fails outright while any other session is
#     running terraform: "The process cannot access the file because
#     another process has locked a portion of the file." An ops command
#     has no business being blocked by someone else's apply.
#
# Falls back to the state file, for the case where the Lambda does not
# exist yet (a first `up` has not run).
db_url_live() {
  local url
  url="$(aws lambda get-function-configuration             --function-name "costhub-${ENV}-api"             --query "Environment.Variables.DATABASE_URL"             --output text 2>/dev/null || true)"
  if [ -n "$url" ] && [ "$url" != "None" ]; then
    printf '%s' "$url"
    return 0
  fi
  echo "  Lambda costhub-${ENV}-api has no DATABASE_URL; falling back to terraform state" >&2
  db_url
}

cmd_cli() {
  # `python -m costhub.cli` with DATABASE_URL pointed at the DEPLOYED
  # database. Without this you get backend/.env, which is the Neon
  # sandbox full of dev_seed rows -- so `status` cheerfully reports a
  # healthy estate that nobody is looking at. Trap 8.
  need_python_deps
  need_env "${1:-}"
  shift
  [ "$#" -gt 0 ] || die "nothing to run: ./do.sh cli $ENV backfill --months 14"
  step "costhub.cli $* ($ENV)"
  local url
  url="$(db_url_live)"
  [ -n "$url" ] || die "could not resolve the deployed DATABASE_URL for $ENV"
  ( cd "$BACKEND" && DATABASE_URL="$url" python -m costhub.cli "$@" )
}

cmd_migrate() {
  need_python_deps
  need_env "${1:-}"
  select_workspace
  step "migrations ($ENV)"
  # Resolved BEFORE the subshell: inside `cd backend`, a relative
  # -chdir=terraform would point at backend/terraform.
  local url
  url="$(db_url)"
  ( cd "$BACKEND" && DATABASE_URL="$url" python -m costhub.migrate )
}

cmd_outputs() {
  need_env "${1:-}"
  select_workspace
  mkdir -p frontend
  # NEXT_PUBLIC_, and .env.local -- not VITE_ and not .env.$ENV.
  #
  # The frontend is Next.js now. Next only exposes variables prefixed
  # NEXT_PUBLIC_ to browser code, and it loads .env.local automatically;
  # it never reads .env.dev. The VITE_ names this used to write were
  # inert in both respects, so the app silently stayed on mock data with
  # no error anywhere.
  #
  # None of these are secrets -- they are compiled into the client
  # bundle and are public by construction. The file is still gitignored
  # (root .gitignore: .env.*), because it is environment-specific, not
  # because it is sensitive.
  local out="frontend/.env.local"
  {
    echo "# Generated by ./do.sh outputs $ENV -- do not edit by hand."
    echo "NEXT_PUBLIC_API_BASE_URL=$($TF output -raw api_url)"
    echo "NEXT_PUBLIC_COGNITO_USER_POOL_ID=$($TF output -raw cognito_user_pool_id)"
    echo "NEXT_PUBLIC_COGNITO_CLIENT_ID=$($TF output -raw cognito_client_id)"
    echo "NEXT_PUBLIC_COGNITO_DOMAIN=$($TF output -raw cognito_domain)"
    echo "NEXT_PUBLIC_AWS_REGION=$REGION"
    # Printed by the "add a cloud account" dialog, inside the trust
    # policy the OTHER account's administrator applies -- it is the
    # principal they have to trust. Public by construction.
    echo "NEXT_PUBLIC_DEPLOY_ACCOUNT_ID=$ACCOUNT_ID"
    echo "NEXT_PUBLIC_USE_MOCK=false"
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
  local url
  url="$(db_url)"
  : > "$out"
  # One pg_dump per table, concatenated in APP_TABLES order. A single
  # multi-table dump emits them alphabetically and breaks foreign keys on
  # restore (access_grants before users).
  for tbl in "${APP_TABLES[@]}"; do
    echo "-- table: $tbl" >> "$out"
    pg_dump "$url" --data-only --no-owner --column-inserts -t "$tbl" >> "$out"
  done
}

cmd_export_data() {
  need_pg
  need_env "${1:-}"
  select_workspace
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/$ENV-$(date -u +%Y%m%dT%H%M%SZ).sql"
  step "backup ($ENV)"
  dump_to "$out"
  echo "wrote $out ($(wc -l < "$out") lines)"
}

cmd_teardown() {
  need_pg
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
  # Anchored: an unanchored .*users matched any line CONTAINING the
  # word, including an audit_log value like 'revoked users access', so a
  # dump with zero user rows passed the guard and destroy proceeded.
  if ! grep -qE '^INSERT INTO (public\.)?users ' "$out"; then
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

  # No bundle rebuild here on purpose. lambda.tf guards the hash with
  # fileexists(), so a missing dist/lambda.zip no longer breaks
  # `plan -destroy` -- and calling cmd_build at this point could fail on
  # its own (pip, network) and abort a teardown AFTER the backup was
  # taken and the confirmation given.

  step "3/4 destroy ($ENV only -- this workspace cannot reach the others)"
  $TF destroy -var-file="env/$ENV.tfvars" -auto-approve

  step "4/4 prove"
  cmd_sweep "$ENV"
}

cmd_sweep() {
  need_env "${1:-}"
  step "resources still tagged Project=$PROJECT,Environment=$ENV"

  # Neither silenced nor `|| true`. Previously a missing credential gave
  # an empty string and this step -- whose entire purpose is to PROVE --
  # printed "teardown complete". A verification whose failure mode is a
  # false pass is worse than no verification.
  local raw
  if ! raw="$(aws resourcegroupstaggingapi get-resources --region "$REGION" \
      --tag-filters "Key=Project,Values=$PROJECT" "Key=Environment,Values=$ENV" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text)"; then
    die "sweep FAILED: the teardown is unproven. Fix credentials, then
       ./do.sh sweep $ENV -- do not assume it completed."
  fi

  local left
  left="$(printf '%s' "$raw" | tr '\t' '\n' | sed '/^$/d')"
  if [ -z "$left" ]; then
    echo "    tagged resources: none"
  else
    echo "$left" | sed 's/^/    /'
  fi

  # An empty result above is NOT proof on its own: the Resource Groups
  # Tagging API does not support IAM roles or Budgets at all, and eight
  # more of our resources carry no tags. The IAM role is exactly what
  # breaks the next apply with EntityAlreadyExists, so probe it directly.
  # The /costhub/ path on the role (iam.tf) is what makes this cheap.
  step "resources the tagging API cannot see (probed directly)"
  local acct roles budgets domain
  acct="$(aws sts get-caller-identity --query Account --output text)" \
    || die "cannot identify the account; sweep is unproven"

  # MSYS_NO_PATHCONV is load-bearing on Git Bash: it rewrites any
  # argument that looks like a POSIX path, so "/costhub/" reached aws.exe
  # as "C:/Program Files/Git/costhub/" and the call failed. Because this
  # probe dies on failure, that one substitution made `sweep` impossible
  # to pass and made `teardown` always exit non-zero at step 4/4 -- after
  # the destroy had already succeeded.
  roles="$(MSYS_NO_PATHCONV=1 aws iam list-roles --path-prefix "/$PROJECT/" \
    --query "Roles[?starts_with(RoleName,'$PROJECT-$ENV')].RoleName" \
    --output text)" || die "iam list-roles failed; sweep is unproven"

  budgets="$(aws budgets describe-budgets --account-id "$acct" \
    --query "Budgets[?starts_with(BudgetName,'$PROJECT-$ENV')].BudgetName" \
    --output text 2>/dev/null)" || budgets="(query failed)"

  # Must match cognito.tf exactly: the domain is prefix + account id
  # (Cognito domains are globally unique, so the account id is what makes
  # a redeploy in another account possible). Probing "$PROJECT-$ENV" could
  # never match what Terraform creates, so this always reported "none".
  domain="$(aws cognito-idp describe-user-pool-domain \
    --domain "$PROJECT-$ENV-$acct" --query 'DomainDescription.Domain' \
    --output text 2>/dev/null)" || domain=""
  [ "$domain" = "None" ] && domain=""

  printf '    iam roles under /%s/ : %s\n' "$PROJECT" "${roles:-none}"
  printf '    budgets              : %s\n' "${budgets:-none}"
  printf '    cognito domain       : %s\n' "${domain:-none}"

  echo
  echo "    Note: the tagging API is eventually consistent, so ARNs can"
  echo "    linger for minutes after a successful destroy. SES identities"
  echo "    and cross-account roles are expected to survive; see docs/13."
}

cmd_restore() {
  need_pg
  need_env "${1:-}"
  local file="${2:-}"
  [ -n "$file" ] || die "usage: ./do.sh restore $ENV backups/$ENV-....sql"
  [ -f "$file" ] || die "no such backup: $file"

  cmd_up "$ENV"

  # DELETE the seeded superadmin before replaying the dump.
  #
  # cmd_up runs the migrations, and 006 seeds a superadmin row with a
  # FRESH uuid. The backup then replays an INSERT for the same email ->
  # UNIQUE violation -> --single-transaction rolls the whole restore
  # back. Every restore failed, which made the backup-before-destroy
  # guard decorative.
  #
  # ON CONFLICT DO NOTHING would not fix it either: the backup's grants
  # and audit rows carry the OLD user uuid, so keeping the newly seeded
  # row would orphan them on the foreign key. The backup's own users
  # table is the authority, so the seed is what has to go.
  step "clearing the seeded superadmin so the backup is the authority"
  psql "$(db_url)" -v ON_ERROR_STOP=1 \
    -v email="$(superadmin_email)" \
    -c "DELETE FROM users WHERE email = :'email';" \
    || die "could not clear the seeded superadmin"

  step "restoring $file"
  psql "$(db_url)" -v ON_ERROR_STOP=1 --single-transaction -f "$file"
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
  cli)         cmd_cli "$@" ;;
  outputs)     cmd_outputs "$@" ;;
  export-data) cmd_export_data "$@" ;;
  teardown)    cmd_teardown "$@" ;;
  sweep)       cmd_sweep "$@" ;;
  restore)     cmd_restore "$@" ;;
  help|-h|--help) cmd_help ;;
  *)           die "unknown command '$CMD' (run ./do.sh help)" ;;
esac
