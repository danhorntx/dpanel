#!/usr/bin/env bash
#
# Server-side deploy for DPanel webmail (vendored duperhuman).
#
# Run on each VPS after `git pull` brings in the latest /opt/dpanel:
#
#   sudo bash /opt/dpanel/scripts/deploy-webmail.sh
#
# Idempotent — safe to run repeatedly. Generates a cookie secret on first
# run, builds the client + server, installs the systemd unit, migrates
# every existing webmail.<domain> Apache vhost to the new template.

set -euo pipefail

DPANEL_ROOT=${DPANEL_ROOT:-/opt/dpanel}
WEBMAIL_ROOT=${DPANEL_ROOT}/webmail
ENV_FILE=${WEBMAIL_ROOT}/.env
UNIT_SRC=${DPANEL_ROOT}/scripts/dpanel-webmail.service
UNIT_DST=/etc/systemd/system/dpanel-webmail.service

step() { printf '\n\033[1;36m> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
[[ -d "$WEBMAIL_ROOT" ]] || { echo "Missing $WEBMAIL_ROOT - pull DPanel first." >&2; exit 1; }

step "Provisioning $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  cookie_secret=$(openssl rand -hex 32)
  cat > "$ENV_FILE" <<EOF
PORT=3501
NODE_ENV=production
DPANEL_MODE=true
DPANEL_COOKIE_SECRET=${cookie_secret}
DPANEL_IMAP_HOST=127.0.0.1
DPANEL_IMAP_PORT=993
DPANEL_IMAP_TLS=true
DPANEL_SMTP_HOST=127.0.0.1
DPANEL_SMTP_PORT=587
DPANEL_SMTP_SECURE=false
ALLOW_INSECURE_MAIL_TLS=true
SYNC_INTERVAL_MS=30000
INITIAL_SYNC_LIMIT=200
EOF
  chmod 600 "$ENV_FILE"
  echo "  Wrote new $ENV_FILE with a fresh cookie secret."
else
  echo "  $ENV_FILE already exists - keeping current cookie secret."
fi

step "Installing webmail dependencies"
cd "$WEBMAIL_ROOT"
npm install --production=false --silent

step "Building client + server"
npm run build

step "Installing systemd unit"
cp "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable dpanel-webmail.service
systemctl restart dpanel-webmail.service

# Wait for the service to come up before announcing success.
sleep 2
if curl -fsS http://127.0.0.1:3501/health >/dev/null; then
  echo "  dpanel-webmail health check passed."
else
  echo "  WARNING: health check failed - check 'journalctl -u dpanel-webmail -n 50'." >&2
fi

step "Migrating webmail.<domain> Apache vhosts to the new template"
node "${DPANEL_ROOT}/scripts/migrate-webmail-vhosts.js"

step "Done"
echo "  New webmail is live. Users can opt back to classic via the in-app toggle."
