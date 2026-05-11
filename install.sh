#!/bin/bash
# ════════════════════════════════════════════════════════════════════════════
#  DPanel — one-shot installer for Ubuntu 22.04 / 24.04 VPS
#
#  Usage:
#    Fresh server, one liner:
#      curl -fsSL https://raw.githubusercontent.com/danhorntx/dpanel/main/install.sh | sudo bash
#
#    With custom admin credentials (skip random-password generation):
#      sudo DPANEL_ADMIN_USERNAME=admin DPANEL_ADMIN_PASSWORD=changeme bash install.sh
#
#    Manual:
#      git clone https://github.com/danhorntx/dpanel /opt/dpanel
#      sudo bash /opt/dpanel/install.sh
#
#  What this installs:
#    Apache 2.4 · MariaDB · Node.js 22 · PM2
#    Postfix · Dovecot · OpenDKIM · postsrsd
#    BIND9 · certbot · vsftpd · UFW
#    DPanel itself at /opt/dpanel, running as systemd service dpanel.service
#
#  Idempotent — safe to re-run; existing state is preserved.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ── Config (env-var overridable) ─────────────────────────────────────────────
INSTALL_DIR="${DPANEL_INSTALL_DIR:-/opt/dpanel}"
GIT_REPO="${DPANEL_GIT_REPO:-https://github.com/danhorntx/dpanel}"
GIT_BRANCH="${DPANEL_GIT_BRANCH:-main}"
ADMIN_USER="${DPANEL_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${DPANEL_ADMIN_PASSWORD:-}"
PANEL_PORT="${DPANEL_PORT:-8080}"
DB_NAME="dpanel"
DB_USER="dpanel"

# ── Output helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()     { echo -e "${CYAN}[install]${NC} $*"; }
ok()      { echo -e "${GREEN}[ ✓ ]${NC} $*"; }
warn()    { echo -e "${YELLOW}[ ! ]${NC} $*"; }
die()     { echo -e "${RED}[ ✗ ]${NC} $*"; exit 1; }
section() { echo ""; echo -e "${CYAN}━━━ $* ━━━${NC}"; }

# ── Preflight ────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (use sudo)."

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  case "${VERSION_ID:-}" in
    22.04|24.04) ok "Ubuntu $VERSION_ID detected" ;;
    *) warn "DPanel is tested on Ubuntu 22.04 / 24.04. You are on ${PRETTY_NAME:-unknown}. Continuing anyway." ;;
  esac
else
  warn "Cannot identify OS — proceeding."
fi

echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║       DPanel — Self-hosted Server Control Panel              ║"
echo "  ║       Installing v2.0 to ${INSTALL_DIR}"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: System packages ──────────────────────────────────────────────────
section "Step 1/9 · System packages"

# Pre-seed Postfix so it installs as "Internet Site" non-interactively
MAIL_HOSTNAME="$(hostname -f 2>/dev/null || hostname)"
debconf-set-selections <<EOF
postfix postfix/mailname string ${MAIL_HOSTNAME}
postfix postfix/main_mailer_type select Internet Site
EOF

log "apt update"
apt-get update -qq

log "Installing base packages (this can take 2-5 minutes)"
apt-get install -y -qq \
  apache2 libapache2-mod-php \
  php php-cli php-mysql php-curl php-mbstring php-xml php-zip php-gd php-intl \
  bind9 bind9utils \
  postfix postfix-mysql \
  dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-mysql dovecot-sieve dovecot-managesieved \
  opendkim opendkim-tools \
  postsrsd \
  mariadb-server mariadb-client \
  certbot python3-certbot-apache \
  vsftpd \
  ufw \
  build-essential python3 python3-pip \
  curl wget rsync git \
  net-tools dnsutils mailutils \
  unzip jq \
  >/dev/null
ok "base packages installed"

# ── Step 2: Node.js 22 + PM2 ─────────────────────────────────────────────────
section "Step 2/9 · Node.js 22 + PM2"

if ! command -v node &>/dev/null || [[ "$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)" -lt 22 ]]; then
  log "Installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)"

if ! command -v pm2 &>/dev/null; then
  log "Installing PM2 globally"
  npm install -g pm2 --silent 2>&1 | tail -1
fi
ok "pm2 $(pm2 --version 2>/dev/null || echo 'present')"

# ── Step 3: Apache modules ───────────────────────────────────────────────────
section "Step 3/9 · Apache modules"
a2enmod rewrite headers ssl proxy proxy_http proxy_wstunnel >/dev/null
systemctl enable --now apache2 >/dev/null
ok "modules enabled"

# ── Step 4: MariaDB — set up dpanel database/user ────────────────────────────
section "Step 4/9 · MariaDB"
systemctl enable --now mariadb >/dev/null

if mysql -e "SELECT 1 FROM mysql.user WHERE User='${DB_USER}'" 2>/dev/null | grep -q 1; then
  ok "MariaDB user '${DB_USER}' already exists — leaving as-is"
  DB_PASSWORD_NEW=0
else
  log "Creating DPanel database + user '${DB_USER}'"
  DB_PASSWORD="$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  mysql <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
  DB_PASSWORD_NEW=1
  ok "MariaDB ready"
fi

# ── Step 5: Firewall ─────────────────────────────────────────────────────────
section "Step 5/9 · Firewall (UFW)"
log "Configuring UFW"
ufw --force reset >/dev/null 2>&1
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp                >/dev/null   # SSH
ufw allow 25/tcp                >/dev/null   # SMTP
ufw allow 53                    >/dev/null   # DNS
ufw allow 80/tcp                >/dev/null   # HTTP (ACME challenges)
ufw allow 443/tcp               >/dev/null   # HTTPS
ufw allow 465/tcp               >/dev/null   # SMTPS
ufw allow 587/tcp               >/dev/null   # Submission
ufw allow 993/tcp               >/dev/null   # IMAPS
ufw allow 995/tcp               >/dev/null   # POP3S
ufw allow ${PANEL_PORT}/tcp     >/dev/null   # DPanel
ufw --force enable              >/dev/null
ok "UFW enabled"

# ── Step 6: DPanel source ────────────────────────────────────────────────────
section "Step 6/9 · DPanel application"

if [[ -d ${INSTALL_DIR}/.git ]]; then
  log "Existing install detected — pulling latest from ${GIT_BRANCH}"
  cd "${INSTALL_DIR}"
  git fetch origin "${GIT_BRANCH}" --quiet
  git reset --hard "origin/${GIT_BRANCH}" --quiet
elif [[ -d ${INSTALL_DIR} ]] && [[ -f ${INSTALL_DIR}/server.js ]]; then
  log "Existing non-git install at ${INSTALL_DIR} — leaving in place"
else
  log "Cloning ${GIT_REPO} (${GIT_BRANCH}) to ${INSTALL_DIR}"
  git clone --depth 1 --branch "${GIT_BRANCH}" "${GIT_REPO}" "${INSTALL_DIR}" >/dev/null
fi
cd "${INSTALL_DIR}"

mkdir -p "${INSTALL_DIR}/logs" "${INSTALL_DIR}/certs" "${INSTALL_DIR}/backups"
chmod 750 "${INSTALL_DIR}/backups"

log "Installing npm dependencies (~1 minute)"
npm install --production --no-audit --no-fund 2>&1 | tail -2
ok "node_modules ready"

# ── Step 7: .env + secrets ───────────────────────────────────────────────────
section "Step 7/9 · Secrets + configuration"

ENV_FILE="${INSTALL_DIR}/.env"
SERVER_IP="$(hostname -I | awk '{print $1}')"

if [[ ! -f ${ENV_FILE} ]]; then
  SESSION_SECRET="$(openssl rand -hex 64)"
  if [[ ${DB_PASSWORD_NEW} -eq 1 ]]; then
    DB_PW_LINE="DB_PASSWORD=${DB_PASSWORD}"
  else
    DB_PW_LINE="DB_PASSWORD=__SET_MANUALLY__"
    warn "DB user existed already — you must set DB_PASSWORD in ${ENV_FILE} manually"
  fi
  cat > "${ENV_FILE}" <<ENV
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_USER}
${DB_PW_LINE}
SESSION_SECRET=${SESSION_SECRET}
DPANEL_SERVER_IP=${SERVER_IP}
IMAP_LOCAL_SERVERNAME=${MAIL_HOSTNAME}
PORT=${PANEL_PORT}
ENV
  chmod 600 "${ENV_FILE}"
  ok ".env written"
else
  ok ".env already present — keeping existing values"
fi

# Self-signed cert for the panel itself
if [[ ! -f ${INSTALL_DIR}/certs/dpanel.crt ]]; then
  log "Generating self-signed cert for the panel (${MAIL_HOSTNAME})"
  openssl req -x509 -newkey rsa:4096 \
    -keyout "${INSTALL_DIR}/certs/dpanel.key" \
    -out    "${INSTALL_DIR}/certs/dpanel.crt" \
    -days 3650 -nodes -subj "/CN=${MAIL_HOSTNAME}" 2>/dev/null
  chmod 600 "${INSTALL_DIR}/certs/dpanel.key" "${INSTALL_DIR}/certs/dpanel.crt"
fi
ok "panel cert present"

# ── Step 8: Mail stack configuration ─────────────────────────────────────────
section "Step 8/9 · Mail stack (Postfix / Dovecot / OpenDKIM / postsrsd)"

# vmail user (uid/gid 5000) — Dovecot virtual mailbox owner
if ! id vmail &>/dev/null; then
  log "Creating vmail user (uid 5000)"
  groupadd -g 5000 vmail 2>/dev/null || groupadd vmail
  useradd -g vmail -u 5000 -s /usr/sbin/nologin -d /var/mail/vhosts vmail
fi
mkdir -p /var/mail/vhosts
chown vmail:vmail /var/mail/vhosts
chmod 770 /var/mail/vhosts

# Postfix virtual maps (empty files Postfix needs to exist)
touch /etc/postfix/vdomains /etc/postfix/vmailbox /etc/postfix/virtual
postmap /etc/postfix/vdomains  /etc/postfix/vmailbox /etc/postfix/virtual

# Postfix main.cf
postconf -e "myhostname = ${MAIL_HOSTNAME}"
postconf -e "smtp_helo_name = ${MAIL_HOSTNAME}"
postconf -e "mydestination = localhost.\$mydomain, localhost"
postconf -e "inet_interfaces = all"
postconf -e "inet_protocols = ipv4"
postconf -e "virtual_mailbox_domains = hash:/etc/postfix/vdomains"
postconf -e "virtual_mailbox_base    = /var/mail/vhosts"
postconf -e "virtual_mailbox_maps    = hash:/etc/postfix/vmailbox"
postconf -e "virtual_alias_maps      = hash:/etc/postfix/virtual"
postconf -e "virtual_uid_maps        = static:5000"
postconf -e "virtual_gid_maps        = static:5000"
postconf -e "virtual_transport       = lmtp:unix:private/dovecot-lmtp"
postconf -e "smtpd_milters     = inet:127.0.0.1:12301"
postconf -e "non_smtpd_milters = inet:127.0.0.1:12301"
postconf -e "milter_default_action = accept"
postconf -e "milter_protocol       = 6"
postconf -e "sender_canonical_maps      = tcp:127.0.0.1:10001"
postconf -e "sender_canonical_classes   = envelope_sender"
postconf -e "recipient_canonical_maps   = tcp:127.0.0.1:10002"
postconf -e "recipient_canonical_classes = envelope_recipient,header_recipient"
postconf -e "smtpd_tls_security_level = may"
postconf -e "smtp_tls_security_level  = may"
postconf -e "smtpd_tls_auth_only      = yes"
postconf -e "smtpd_sasl_type          = dovecot"
postconf -e "smtpd_sasl_path          = private/auth"
postconf -e "smtpd_sasl_auth_enable   = yes"
postconf -e "smtpd_sasl_security_options = noanonymous"
postconf -e "smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination"

# Submission service on port 587 with SASL
postconf -M submission/inet="submission inet n - y - - smtpd" 2>/dev/null || true
postconf -P "submission/inet/syslog_name=postfix/submission"
postconf -P "submission/inet/smtpd_tls_security_level=encrypt"
postconf -P "submission/inet/smtpd_sasl_auth_enable=yes"
postconf -P "submission/inet/smtpd_relay_restrictions=permit_sasl_authenticated,reject"
postconf -P "submission/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject"

# Dovecot — virtual user auth
sed -i 's|^#*mail_location\s*=.*|mail_location = maildir:/var/mail/vhosts/%d/%n/Maildir|' /etc/dovecot/conf.d/10-mail.conf
sed -i 's|^#*mail_privileged_group\s*=.*|mail_privileged_group = vmail|'                    /etc/dovecot/conf.d/10-mail.conf
sed -i 's|^#*disable_plaintext_auth\s*=.*|disable_plaintext_auth = no|'                     /etc/dovecot/conf.d/10-auth.conf
sed -i 's|^#*auth_mechanisms\s*=.*|auth_mechanisms = plain login|'                          /etc/dovecot/conf.d/10-auth.conf
sed -i 's|^!include auth-system.conf.ext|#!include auth-system.conf.ext|'                   /etc/dovecot/conf.d/10-auth.conf
sed -i 's|^#!include auth-passwdfile.conf.ext|!include auth-passwdfile.conf.ext|'           /etc/dovecot/conf.d/10-auth.conf
grep -q '^!include auth-passwdfile.conf.ext' /etc/dovecot/conf.d/10-auth.conf || \
  echo '!include auth-passwdfile.conf.ext' >> /etc/dovecot/conf.d/10-auth.conf

touch /etc/dovecot/users
chown root:dovecot /etc/dovecot/users
chmod 640 /etc/dovecot/users

cat > /etc/dovecot/conf.d/auth-passwdfile.conf.ext <<'EOF'
# DPanel-managed: virtual user auth backed by /etc/dovecot/users
passdb {
  driver = passwd-file
  args   = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/users
}
userdb {
  driver = passwd-file
  args   = username_format=%u /etc/dovecot/users
  override_fields = uid=vmail gid=vmail home=/var/mail/vhosts/%d/%n
}
EOF

cat > /etc/dovecot/conf.d/99-dpanel-postfix.conf <<'EOF'
# DPanel-managed: sockets Postfix needs to talk to Dovecot.
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode  = 0600
    user  = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode  = 0660
    user  = postfix
    group = postfix
  }
}
EOF

# OpenDKIM
sed -i 's|^#*Socket\s.*|Socket inet:12301@127.0.0.1|' /etc/opendkim.conf
sed -i 's|^#*Mode\s.*|Mode sv|'                       /etc/opendkim.conf
grep -q '^KeyTable'     /etc/opendkim.conf || echo 'KeyTable refile:/etc/opendkim/KeyTable'         >> /etc/opendkim.conf
grep -q '^SigningTable' /etc/opendkim.conf || echo 'SigningTable refile:/etc/opendkim/SigningTable' >> /etc/opendkim.conf
mkdir -p /etc/opendkim
touch /etc/opendkim/KeyTable /etc/opendkim/SigningTable /etc/opendkim/TrustedHosts
grep -q '127.0.0.1' /etc/opendkim/TrustedHosts || cat >> /etc/opendkim/TrustedHosts <<EOF
127.0.0.1
::1
localhost
${SERVER_IP}
EOF
grep -q '^ExternalIgnoreList' /etc/opendkim.conf || echo 'ExternalIgnoreList /etc/opendkim/TrustedHosts' >> /etc/opendkim.conf
grep -q '^InternalHosts'      /etc/opendkim.conf || echo 'InternalHosts      /etc/opendkim/TrustedHosts' >> /etc/opendkim.conf
chown -R opendkim:opendkim /etc/opendkim

# postsrsd
if [[ -f /etc/default/postsrsd ]]; then
  sed -i "s|^SRS_DOMAIN=.*|SRS_DOMAIN=${MAIL_HOSTNAME}|" /etc/default/postsrsd
elif [[ -f /etc/postsrsd.conf ]]; then
  sed -i "s|^domain=.*|domain = ${MAIL_HOSTNAME}|" /etc/postsrsd.conf
fi

# Validate + reload
postfix check  && ok "postfix check OK"
doveconf -n > /dev/null && ok "doveconf OK"
systemctl enable --now opendkim postsrsd >/dev/null
systemctl restart opendkim postsrsd dovecot postfix
ok "mail stack restarted"

# ── Step 9: dpanel systemd service + admin bootstrap ─────────────────────────
section "Step 9/9 · DPanel service + admin user"

cp "${INSTALL_DIR}/dpanel.service" /etc/systemd/system/dpanel.service
systemctl daemon-reload
systemctl enable dpanel >/dev/null 2>&1 || true

log "Starting dpanel (initial run creates the schema)"
systemctl restart dpanel
sleep 4
if ! systemctl is-active --quiet dpanel; then
  warn "dpanel did not start. Recent logs:"
  journalctl -u dpanel -n 30 --no-pager
  die "Aborting — fix dpanel and re-run."
fi
ok "dpanel.service running"

# Admin bootstrap — generate random password if not provided via env
if [[ -z "${ADMIN_PASSWORD}" ]]; then
  ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 20)"
  GENERATED_PW=1
else
  GENERATED_PW=0
fi

USER_CNT="$(mysql -N -B -e "SELECT COUNT(*) FROM dpanel_users" "${DB_NAME}" 2>/dev/null || echo 0)"
if [[ "${USER_CNT}" == "0" ]]; then
  log "Seeding admin user '${ADMIN_USER}'"
  HASH="$(cd ${INSTALL_DIR} && node -e "require('bcryptjs').hash(process.argv[1], 12).then(h => process.stdout.write(h))" "${ADMIN_PASSWORD}")"
  mysql "${DB_NAME}" <<SQL
INSERT INTO dpanel_users (username, password_hash, role) VALUES ('${ADMIN_USER}', '${HASH}', 'admin');
SQL
  echo "${ADMIN_PASSWORD}" > "${INSTALL_DIR}/.admin-bootstrap-password"
  chmod 600 "${INSTALL_DIR}/.admin-bootstrap-password"
  ok "admin user '${ADMIN_USER}' created"
else
  ok "admin user already exists — leaving in place"
  GENERATED_PW=0
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║         DPanel v2.0 installed successfully!                  ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Panel URL :  ${CYAN}https://${SERVER_IP}:${PANEL_PORT}${NC}"
echo -e "                (self-signed cert — accept the browser warning)"
echo -e "  Username  :  ${ADMIN_USER}"
if [[ "${GENERATED_PW}" == "1" ]]; then
echo -e "  Password  :  ${YELLOW}${ADMIN_PASSWORD}${NC}"
echo -e "               (also saved to ${INSTALL_DIR}/.admin-bootstrap-password)"
fi
echo ""
echo -e "  Stack     :  apache2 mariadb bind9 postfix dovecot opendkim postsrsd vsftpd"
echo -e "  Logs      :  ${CYAN}journalctl -u dpanel -f${NC}"
echo -e "  Restart   :  ${CYAN}systemctl restart dpanel${NC}"
echo -e "  Update    :  ${CYAN}cd ${INSTALL_DIR} && git pull && npm install --production && systemctl restart dpanel${NC}"
echo ""
echo -e "  ${CYAN}Next steps${NC} (recommended order):"
echo -e "    1. Log in, change the admin email + enable 2FA (Settings)"
echo -e "    2. Point your panel's DNS at this server"
echo -e "    3. Issue a real Let's Encrypt cert: certbot --apache -d panel.yourdomain.com"
echo -e "    4. Set the panel's PTR (rDNS) at your VPS provider to mail.yourdomain.com"
echo -e "    5. Add your first domain via the Domains section"
echo ""
echo -e "  ${CYAN}Documentation${NC}"
echo -e "    Panel:  https://${SERVER_IP}:${PANEL_PORT}/admin-guide.html"
echo -e "    GitHub: https://github.com/danhorntx/dpanel"
echo ""
