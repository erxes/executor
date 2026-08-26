#!/usr/bin/env bash
# Deploy one Executor Cloudflare host for a Cloudflare OS instance.
#
# The default is the internal erxes demo:
#   worker: erxes-os-internal-executor
#   domain: executor.os.erxes.io
#   D1:     erxes-os-internal-executor
#   R2:     erxes-os-internal-executor-blobs
#
# Set INSTANCE_SLUG and EXECUTOR_DOMAIN for another tenant. Every resource name
# follows INSTANCE_SLUG so multiple installations can share one CF account.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_CONFIG="$APP_DIR/wrangler.jsonc"
CONFIG="$APP_DIR/wrangler.instance.jsonc"
SECRETS_FILE="${EXECUTOR_SECRETS_FILE:-$APP_DIR/deploy-secrets.json}"
cd "$APP_DIR"

EXPECTED_ACCOUNT_ID="7c8392aff8ac4518aa06dfa4b6337ef2"
INSTANCE_SLUG="${INSTANCE_SLUG:-erxes-os-internal}"
EXECUTOR_DOMAIN="${EXECUTOR_DOMAIN:-executor.os.erxes.io}"
WORKER_NAME="${INSTANCE_SLUG}-executor"
DATABASE_NAME="$WORKER_NAME"
BUCKET_NAME="${WORKER_NAME}-blobs"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() { printf 'deploy: %s\n' "$1" >&2; exit 1; }

[ "${CLOUDFLARE_ACCOUNT_ID:-}" = "$EXPECTED_ACCOUNT_ID" ] || die \
  "CLOUDFLARE_ACCOUNT_ID must be pinned to erxes Inc ($EXPECTED_ACCOUNT_ID)"

step "Checking wrangler login"
bunx wrangler whoami >/dev/null 2>&1 || die "not logged in; run bunx wrangler login"
info "account: erxes Inc ($EXPECTED_ACCOUNT_ID)"

step "Provisioning D1 database '$DATABASE_NAME'"
DB_ID="$(bunx wrangler d1 list --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(r?r.uuid:"")}catch{}})' "$DATABASE_NAME")"
if [ -z "$DB_ID" ]; then
  CREATE_OUT="$(bunx wrangler d1 create "$DATABASE_NAME" 2>&1)"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  info "created: $DB_ID"
else
  info "reusing: $DB_ID"
fi
[ -n "$DB_ID" ] || die "failed to resolve D1 database id"

step "Provisioning R2 bucket '$BUCKET_NAME'"
if bunx wrangler r2 bucket list 2>/dev/null | grep -q "$BUCKET_NAME"; then
  info "reusing existing bucket"
else
  bunx wrangler r2 bucket create "$BUCKET_NAME" >/dev/null
  info "created"
fi

step "Generating instance config"
cp "$SOURCE_CONFIG" "$CONFIG"
node - "$CONFIG" "$DB_ID" "$DATABASE_NAME" "$BUCKET_NAME" "$WORKER_NAME" "$EXECUTOR_DOMAIN" <<'NODE'
const fs = require("node:fs");
const [path, dbId, dbName, bucketName, workerName, domain] = process.argv.slice(2);
let text = fs.readFileSync(path, "utf8");
text = text.replace(/("name":\s*")[^"]*(")/, `$1${workerName}$2`);
text = text.replace(/("database_name":\s*")[^"]*(")/, `$1${dbName}$2`);
text = text.replace(/("database_id":\s*")[^"]*(")/, `$1${dbId}$2`);
text = text.replace(/("bucket_name":\s*")[^"]*(")/, `$1${bucketName}$2`);
text = text.replace(
  /(\s*"main":\s*"src\/worker\.ts",)/,
  `$1\n  "routes": [{ "pattern": "${domain}", "custom_domain": true }],`,
);
text = text.replace(
  /(\s*"vars":\s*{)/,
  `$1\n    // Direct UI stays fail-closed until an erxes Access app replaces these values.\n` +
  `    // Signed /os/* calls from Cloudflare OS verify before Access and work immediately.\n` +
  `    "ACCESS_TEAM_DOMAIN": "invalid.cloudflareaccess.com",\n` +
  `    "ACCESS_AUD": "not-configured",\n` +
  `    "ADMIN_EMAILS": "amaraaamka0404@gmail.com",`,
);
fs.writeFileSync(path, text);
NODE
info "$CONFIG"

step "Ensuring deployment secrets"
if [ ! -f "$SECRETS_FILE" ]; then
  node - "$SECRETS_FILE" <<'NODE'
const { randomBytes } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const path = process.argv[2];
writeFileSync(path, JSON.stringify({
  EXECUTOR_SECRET_KEY: randomBytes(32).toString("hex"),
  CLOUDFLARE_OS_AUTH_SECRET: randomBytes(32).toString("hex"),
}, null, 2) + "\n", { mode: 0o600 });
NODE
  info "generated $SECRETS_FILE"
else
  info "reusing $SECRETS_FILE"
fi
chmod 600 "$SECRETS_FILE"

step "Building the web SPA"
bunx vite build
node scripts/assert-shell-asset.mjs

if [ "${1:-}" = "--dry-run" ]; then
  info "dry-run: skipped Worker deploy and secret upload"
  exit 0
fi

step "Deploying '$WORKER_NAME'"
bunx wrangler deploy -c "$CONFIG"

step "Uploading secrets"
bunx wrangler secret bulk -c "$CONFIG" < "$SECRETS_FILE" >/dev/null
info "EXECUTOR_SECRET_KEY and CLOUDFLARE_OS_AUTH_SECRET uploaded"

cat <<NEXT

Executor is live at https://$EXECUTOR_DOMAIN

Direct browser access remains closed until an erxes Cloudflare Access app is configured.
Cloudflare OS calls to /os/* are ready now via the generated shared secret.
NEXT
