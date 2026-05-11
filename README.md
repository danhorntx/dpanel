<div align="center">

# DPanel

**A self-hosted server control panel that doesn't suck.**

[![Version](https://img.shields.io/badge/version-2.0.0-4f8ef7)](https://github.com/danhorntx/dpanel/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-4ade80)](LICENSE)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-22.04%20%7C%2024.04-E95420?logo=ubuntu&logoColor=fff)](https://ubuntu.com)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&logoColor=fff)](https://nodejs.org)

</div>

DPanel is a free, open-source alternative to cPanel / Plesk / DirectAdmin for managing a single
VPS. It runs as a Node.js service, serves a fast single-page admin UI, and orchestrates the
boring-but-tedious bits of running web hosting: Apache vhosts, BIND9 DNS zones, Let's Encrypt SSL
issuance, Postfix/Dovecot mail with deliverability monitoring, MariaDB management with an
in-panel browser, scheduled backups + restore, file management, a Node/Python app runner via
PM2, a webmail UI, traffic analytics, and a WebSocket-based browser terminal.

It's built from scratch — no Plesk wrappers, no aging Perl, no $45/month license.

> Why? Because installing cPanel costs more than your VPS, and the UI was designed in 2003.

---

## Quick install

On a **fresh Ubuntu 22.04 or 24.04 VPS** as root:

```bash
curl -fsSL https://raw.githubusercontent.com/danhorntx/dpanel/main/install.sh | sudo bash
```

That's it. The installer:

- Installs the full stack (Apache, MariaDB, Postfix, Dovecot, OpenDKIM, BIND9, certbot, Node.js, PM2, UFW)
- Configures all services with sane defaults
- Generates secrets + a random admin password
- Brings the panel up at `https://<your-ip>:8080` in 5–8 minutes

When it's done you'll get a summary with the login URL + auto-generated password. Save the
password to your password manager — you can change it from Settings after first login.

```bash
# To pre-set the admin credentials (skip the random password generation):
sudo DPANEL_ADMIN_USERNAME=admin DPANEL_ADMIN_PASSWORD='your-strong-password' bash install.sh
```

After install: log in → **Settings → Two-Factor Authentication → Enable**. Highly recommended
before doing anything else.

---

## What's in the box

<!-- TODO: add a hero screenshot of the dashboard here -->

### 🌐 Hosting

- **Atomic domain provisioning** — one click creates Apache vhost, SFTP user, BIND zone, mail
  records, autoconfig vhost, webmail proxy, and Let's Encrypt cert. 13-step reconciler with
  per-step rollback if anything fails.
- **Domain Health dashboard** — per-domain aggregator: SSL expiry, DNS, mail probe summary,
  backup age, disk usage, PHP version, recent Apache errors.
- **Per-domain redirects** — `.htaccess` manager for 301/302 URL redirects.

### 📨 Mail

- **Per-domain mail** — MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT all auto-published.
- **Mail Health probe** — 11 deliverability checks including rDNS forward-confirm, HELO match,
  cert validity, and RBL listings on Spamhaus / Barracuda / SpamCop / SORBS. Runs daily,
  alerts on failure.
- **DMARC aggregate report processor** — IMAP fetches your daily reports, parses XML (gz/zip),
  stores per-source trends.
- **Webmail** — built-in IMAP/SMTP web client. Supports drafts, threading, attachments,
  spam scoring.
- **Per-domain TLS via Dovecot SNI** — each domain gets its own cert served correctly.
- **Forwarding with local-keep** — shadow address pattern keeps a local copy when forwarding.

### 🔐 Security

- **Two-Factor Authentication** (TOTP) — works with any standard authenticator app.
- **API Keys** — bearer tokens with `admin` or `read` scope for external automation.
  Audit-logged, SHA-256 hashed.
- **Audit log** — every state-changing admin action recorded with user, IP, target.
- **Brute-force lockout** — IP-tracked, 5 fails / 15 min → lockout.
- **Domain scoping** — non-admin users can be restricted to specific domains.

### 💾 Data

- **In-panel database browser** — phpMyAdmin-equivalent: tables, structure, row pagination,
  free-form SQL runner, audit-logged.
- **Backups** — files (tar.gz) + databases (gzipped mysqldump). Restore from the UI with
  type-`RESTORE`-to-confirm guard.
- **File manager** — browse, edit, upload, chmod, archive extract (.zip / .tar.gz / .tar.bz2 /
  .tar), bulk delete + move, image preview.

### 🚀 Apps

- **WordPress installer** via WP-CLI — runs async via the job queue.
- **Node.js / Python app manager** — deploy long-running services with PM2 + Apache reverse
  proxy, auto port allocation, live log streaming.
- **Git deploy** — webhook or manual trigger per domain.

### 📊 Operations

- **DAnalytics** — Apache log ingestion with geo + bot detection, dashboard, scheduled email
  reports, bot signals.
- **Cron job manager** — schedule, edit, list, remove.
- **UFW firewall** UI.
- **PHP version switching** per domain.
- **Service health monitor** with email alerts (SSL expiry, mail-health failures, backups, new-IP
  logins).
- **WebSocket terminal** in the browser.

### 📱 Modern UI

- Fully responsive — usable on a phone, hamburger nav, table priority columns, bottom-sheet
  modals, touch-target sizing.
- Single-page admin app, no page reloads.
- Built-in changelog viewer + interactive user guide.

---

## Requirements

| | Minimum | Recommended |
|---|---|---|
| **OS** | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| **RAM** | 1 GB | 2 GB+ |
| **Disk** | 20 GB | 40 GB+ |
| **CPU** | 1 vCPU | 2+ vCPU |
| **Network** | Public IPv4 | + reverse DNS configurable |

For mail deliverability to work properly you'll also need:
- **rDNS (PTR)** configurable at your VPS provider (Contabo, Hetzner, DigitalOcean, Vultr — all
  support this)
- **IP not on Spamhaus PBL** (some VPS provider IP ranges are blanket-listed; check before
  committing)

DPanel runs comfortably on a $5/mo Contabo or DigitalOcean droplet for a single small site.

---

## Manual install

If you'd rather see what the installer does before running it:

<details>
<summary>Read install.sh and run step by step</summary>

```bash
# 1. Clone
git clone https://github.com/danhorntx/dpanel /opt/dpanel
cd /opt/dpanel

# 2. Read what we're about to run
less install.sh

# 3. Run
sudo bash install.sh
```

The script is self-documenting — each step is logged as it runs. It's idempotent so safe to
re-run if anything fails partway through.

</details>

<details>
<summary>What the installer does, in order</summary>

1. **Preflight** — root check, OS check (Ubuntu 22.04 / 24.04 expected)
2. **apt install** — Apache 2.4, MariaDB, Postfix, Dovecot, OpenDKIM, postsrsd, BIND9, certbot,
   vsftpd, UFW, build tools, dnsutils, jq, etc.
3. **Node.js 22 + PM2** — from NodeSource
4. **Apache modules** — rewrite, headers, ssl, proxy, proxy_http, proxy_wstunnel
5. **MariaDB** — creates `dpanel` database + user with a random password
6. **UFW firewall** — opens 22, 25, 53, 80, 443, 465, 587, 993, 995, and the panel port (8080)
7. **Clone DPanel** to `/opt/dpanel`, run `npm install --production`
8. **`.env` + secrets** — generates `SESSION_SECRET`, writes DB password, generates self-signed
   panel cert
9. **Mail stack config** — creates vmail user (uid 5000), configures Postfix `main.cf` for
   virtual delivery via Dovecot LMTP, sets up Dovecot virtual user auth via `/etc/dovecot/users`
   passwd-file, wires OpenDKIM milter into Postfix, configures postsrsd for SRS on forwards
10. **systemd** — installs `dpanel.service`, starts it, runs schema migrations
11. **Admin bootstrap** — inserts the first admin user into the DB with a bcrypt'd password
12. **Print summary** — login URL, credentials, useful commands

</details>

---

## First-time setup

After install, in order:

1. **Log in** at `https://<your-ip>:8080` with the credentials from the install summary.
2. **Settings → Admin Contact Email** — set your real email. This is used for Let's Encrypt
   registrations and panel alerts.
3. **Settings → Two-Factor Authentication → Enable 2FA**. Save the secret in a password
   manager *before* clicking Verify — there are no backup codes; recovery is via SSH.
4. **Set the server's reverse DNS** — at your VPS provider's control panel, set the PTR for
   your server IP to something like `mail.yourdomain.com` (or `<short-name>.yourdomain.com`).
   This is one of the strongest deliverability signals.
5. **Get a real cert for the panel itself** (optional but nicer):
   ```bash
   # Point panel.yourdomain.com DNS at your server, then:
   certbot --apache -d panel.yourdomain.com --non-interactive --agree-tos -m you@example.com
   ```
   The panel keeps using its self-signed cert for the Node server; Apache reverse-proxies
   `panel.yourdomain.com` → `127.0.0.1:8080` with the real cert.
6. **Add your first domain** — Domains → Add Domain. Check the "Set up mail" box if you want
   the full mail stack (MX, SPF, DKIM, DMARC, MTA-STS, autoconfig, webmail) created in one
   shot.
7. **Run the Mail Health probe** for that domain — Mail → Health → pick domain → Run Probe.
   Fix any reds. (rDNS at the provider, RBL delisting if applicable.)

---

## Updating

```bash
cd /opt/dpanel
git pull
npm install --production
systemctl restart dpanel
```

Schema migrations run automatically on startup. They're all `IF NOT EXISTS` and safe to re-run.

For major upgrades, check the [CHANGELOG.md](CHANGELOG.md) — anything requiring operator action
(new env vars, manual data migration) is called out in the release notes.

---

## Configuration

DPanel reads its config from `/opt/dpanel/.env`. Most values are set by the installer; you can
edit them later and `systemctl restart dpanel`.

| Variable | Purpose |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` | MariaDB connection (defaults: 127.0.0.1, 3306, dpanel, generated) |
| `SESSION_SECRET` | 64-byte hex string used to sign session cookies. Generated; **never commit**. |
| `DPANEL_SERVER_IP` | Server's public IP. Used in DNS records the panel writes. Defaults to `hostname -I`. |
| `IMAP_LOCAL_SERVERNAME` | Fallback hostname used for IMAP TLS when no per-domain cert exists. Defaults to `hostname -f`. |
| `DPANEL_MAIL_HOSTNAME` | Postfix HELO / `myhostname`. Should resolve to your server's IP and match its PTR. |
| `PORT` | Panel listening port (default 8080). |

Optional (only set if you use the corresponding feature):

| Variable | Purpose |
|---|---|
| `DMARC_INBOX_EMAIL` / `DMARC_INBOX_PASSWORD` | Mailbox the DMARC report processor reads from. Daily 4:30am cron. |
| `DPANEL_SEED_GMAIL` + `_PASSWORD` | Seed account for deliverability testing (use a Gmail app password). |
| `DPANEL_SEED_OUTLOOK` + `_PASSWORD` | Same for Outlook (app password required). |
| `DPANEL_SEED_YAHOO` + `_PASSWORD` | Same for Yahoo. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (admin or webmail user)                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS
┌───────────────────────────▼─────────────────────────────────────┐
│  Apache 2.4 — reverse proxy + Let's Encrypt termination          │
│  • panel.yourdomain.com  → 127.0.0.1:8080                       │
│  • webmail.<domain>      → 127.0.0.1:8080 (proxied)             │
│  • <domain>              → /var/www/<domain>/public_html        │
│  • autoconfig.<domain>   → static XML for mail clients          │
│  • mta-sts.<domain>      → static policy file                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  DPanel (Node.js / Express, port 8080)                           │
│  • server.js             — Express app + cron scheduler          │
│  • lib/                  — primitives (apache, dns, mail, ssl,   │
│                            mysql-browser, totp, jobqueue, …)     │
│  • lib/state/domain.js   — atomic domain reconciler              │
│  • routes/               — HTTP handlers + WebSocket terminal    │
│  • public/               — single-page admin UI + webmail        │
└───┬───┬───┬───┬───┬───┬─────────────────────────────────────────┘
    │   │   │   │   │   │
    ▼   ▼   ▼   ▼   ▼   ▼
  ┌───┐┌───┐┌───┐┌───┐┌───┐┌───┐
  │MDB││ A ││BND││PSX││DVC││OPN│   System services
  └───┘└───┘└───┘└───┘└───┘└───┘
  MariaDB  Apache  BIND9  Postfix  Dovecot  OpenDKIM

  (Plus: postsrsd · certbot · PM2 · vsftpd · UFW · systemd)
```

DPanel runs as `root` because it shells out to system tools (`useradd`, `systemctl`, `certbot`,
`apache2ctl`, `postmap`, `opendkim-genkey`, etc.) and writes config files in `/etc/`. This is
deliberate and matches the pattern of every comparable control panel.

---

## Development

DPanel is plain Node.js — no build step, no transpilation.

```bash
# Local clone
git clone https://github.com/danhorntx/dpanel
cd dpanel
npm install

# Run against a remote MariaDB (set DB_* env vars in .env)
node server.js
```

Code style:
- `'use strict'` at the top of every file
- 2-space indent
- Files under 400 lines preferred
- Vanilla DOM in the frontend (no React/Vue) — keeps the SPA fast and zero-build
- Pool-based DB access via `mysql2/promise`

Schema migrations: add `ALTER TABLE ... IF NOT EXISTS` or `CREATE TABLE ... IF NOT EXISTS` to
`lib/db.js`'s `migrate()` function. Runs every startup.

---

## Contributing

Issues + PRs welcome at https://github.com/danhorntx/dpanel.

The repo also ships these helpful docs:

- [CHANGELOG.md](CHANGELOG.md) — version history
- [DECISIONS.md](DECISIONS.md) — architecture decision log
- [PROD_MIGRATIONS.md](PROD_MIGRATIONS.md) — upgrade checklist for existing installs

For any feature that touches the system layer (Apache, mail, DNS) we generally expect:
- An idempotent change (safe to apply twice)
- A rollback path
- Documentation in `PROD_MIGRATIONS.md` if existing prod data needs migration

---

## Troubleshooting

| Symptom | First check |
|---|---|
| Panel won't start | `journalctl -u dpanel -n 50 --no-pager` |
| 502/503 from panel.yourdomain.com | Apache → 8080 path: `curl -k https://localhost:8080/` from the server; check `/var/log/apache2/panel_error.log` |
| Mail lands in spam | Mail → Health → Run Probe; fix rDNS, HELO, RBL, MTA-STS in that order |
| DB backup is 20 bytes | Pre-v2.0 bug — upgrade and take fresh backups |
| Webmail returns 403 | Check `apache2ctl -S \| grep webmail.<domain>` — should resolve to its own vhost, not autoconfig's |
| Schema seems off | Restart dpanel; migrations auto-run |
| Lost 2FA / phone | SSH to server: `mysql -e "UPDATE dpanel_users SET totp_enabled=0, totp_secret=NULL WHERE username='admin'" dpanel` |

---

## License

[MIT](LICENSE) — use it, fork it, sell it, host it. Attribution appreciated but not required.

---

<div align="center">

Built with care over many late nights · contributions welcome ·
[file an issue](https://github.com/danhorntx/dpanel/issues) ·
[releases](https://github.com/danhorntx/dpanel/releases)

</div>
