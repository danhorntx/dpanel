#!/bin/bash
set -e

# ── DPanel Installer ─────────────────────────────────────────────────────────
# Run as root on Ubuntu 22.04

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[DPanel]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
die()     { echo -e "${RED}[✗] $1${NC}"; exit 1; }

[[ $EUID -ne 0 ]] && die "This script must be run as root."

INSTALL_DIR="/opt/dpanel"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║     DPanel — Installation        ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# ── 1. Node.js ───────────────────────────────────────────────────────────────
info "Checking Node.js..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(parseInt(process.versions.node)<18?1:0)' 2>/dev/null; echo $?)" == "1" ]]; then
  info "Installing Node.js 18 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi
success "Node.js $(node -v)"

# ── 2. Build tools for node-pty ──────────────────────────────────────────────
info "Installing build dependencies for node-pty..."
apt-get install -y build-essential python3 || true

# ── 3. Copy files ────────────────────────────────────────────────────────────
info "Installing DPanel to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
rsync -a --exclude='.git' --exclude='node_modules' "${SCRIPT_DIR}/" "${INSTALL_DIR}/"
mkdir -p "${INSTALL_DIR}/logs" "${INSTALL_DIR}/certs"
success "Files copied"

# ── 4. npm install ───────────────────────────────────────────────────────────
info "Installing Node dependencies..."
cd "${INSTALL_DIR}"
npm install --production 2>&1 | tail -5
success "Dependencies installed"

# ── 5. Setup wizard ──────────────────────────────────────────────────────────
info "Running first-time setup..."
node setup.js

# ── 6. systemd service ───────────────────────────────────────────────────────
info "Installing systemd service..."
cp "${INSTALL_DIR}/dpanel.service" /etc/systemd/system/dpanel.service
systemctl daemon-reload
systemctl enable dpanel
systemctl restart dpanel
sleep 2
if systemctl is-active --quiet dpanel; then
  success "dpanel service is running"
else
  warn "Service may not have started. Check: journalctl -u dpanel -n 30"
fi

# ── 7. Firewall ───────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  info "Opening port 8080 in UFW..."
  ufw allow 8080/tcp
  success "UFW rule added"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              DPanel installed successfully!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo -e "  Panel URL:  ${CYAN}https://${IP}:8080${NC}"
echo -e "  (Your browser will warn about the self-signed cert — this is expected.)"
echo -e "  Accept it, and you'll see the DPanel login."
echo ""
echo -e "  To view logs:  journalctl -u dpanel -f"
echo -e "  To restart:    systemctl restart dpanel"
echo -e "  To change pw:  cd ${INSTALL_DIR} && node setup.js"
echo ""
