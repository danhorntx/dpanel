# Changelog

All notable changes to DPanel are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and DPanel adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

#### DNS zone round-trip (`lib/dns.js`)
Every zone mutation rewrites the whole zone file, so any record the parser
could not represent faithfully was silently altered or dropped on the next
unrelated edit. Three such cases are fixed:

- **SRV records lost their trailing dot.** `parseZone` stripped it from every
  non-TXT value, but `renderZone` restored it only for CNAME and MX. An SRV
  target `sip.example.com.` became `sip.example.com`, which BIND then resolved
  relative to `$ORIGIN` as `sip.example.com.<zone>`. The record survived its own
  creation and broke on the next edit to that zone. The trailing dot is now
  stripped only for the types that get one back; everything else round-trips
  verbatim.
- **Subdomain NS delegations were deleted.** `parseZone` skipped *all* NS
  records as infrastructure, so an operator-added delegation
  (`sub IN NS ns1.other.net.`) vanished on the next zone write. Only apex NS
  records are skipped now.
- **The SOA serial could go backwards.** The `YYYYMMDDNN` scheme has room for
  99 revisions per day; the 100th produced an 11-digit serial that overflows the
  uint32 SOA field and could not be read back, so the following write reset to
  `0` and regressed. `nextSerial` now rolls the date prefix forward, and every
  path is guarded to return a strictly larger, in-range, 10-digit serial.

### Added

- **`DPANEL_NS1` / `DPANEL_NS2`** — the vanity nameserver pair is no longer
  hard-coded, so a second host can advertise its own. Defaults are unchanged
  (`ns1`/`ns2.danhorntx.com`), so existing installs behave exactly as before.
- **NS re-stamp audit trail.** The apex NS RRset and SOA MNAME are re-stamped on
  every zone write, so an unrelated record edit can silently re-delegate a zone
  once this pair changes. That behaviour is intentional but is now logged
  (`dns:ns-restamp`) with the before and after values.
- **BIND reload failures are reported.** `reloadBind()` swallowed every error,
  leaving BIND serving stale data with no signal. It now logs
  (`dns:reload-failed`) and returns a status. It still does not throw — the zone
  file on disk is already validated, and rolling back a good write over a
  transient `rndc` hiccup would be the worse failure.

### Removed

- **`panel.<domain>` A record** is no longer written into new zones. The panel is
  only served at each host's own hostname, so this stamped a record pointing at
  an unserved name into every zone (13 dead records cleaned up 2026-08-13).

## [2.0.0] – 2026-05-11

Major release. New security features, a complete mail deliverability stack,
in-panel database browser, Node/Python app manager, full backup restore,
comprehensive responsive design, and the refreshed user guide.

### Added

#### Security
- **Two-Factor Authentication (TOTP)** — RFC 6238, works with any standard
  authenticator app. New-IP login alerts. Disable requires current password.
- **API Keys** — bearer tokens (`dpk_…`) for external automation, with
  `admin` and `read` scopes. Audit-logged. SHA-256 hashed at rest.
- **Audit Log UI** — searchable, filterable view of every state-changing
  admin action.
- **Login attempt tracking** — DB-backed brute-force lockout (5 fails / 15
  min) on top of the existing rate limiter.

#### Mail & Deliverability
- **Mail Health Probe** — 11 deliverability checks (rDNS, HELO, MX,
  SPF, DKIM, DMARC, MTA-STS, TLS-RPT, TLS cert, RBL listings on Spamhaus /
  Barracuda / SpamCop / SORBS). Daily cron, alert on failure.
- **MTA-STS** (RFC 8461) — policy file + `mta-sts.<domain>` Apache vhost +
  `_mta-sts` DNS record, auto-published per mail-enabled domain.
- **TLS-RPT** (RFC 8460) — `_smtp._tls.<domain>` TXT auto-published.
- **DMARC Aggregate Report Processor** — IMAP fetch from a configured inbox,
  parse XML (with `.gz` / `.zip` / raw decoding), store in
  `dpanel_dmarc_reports` keyed by `(org_name, report_id)`.
- **Per-domain IMAP TLS via Dovecot SNI** — `local_name` blocks managed in
  `/etc/dovecot/conf.d/95-dpanel-sni.conf`. ImapFlow client picks the right
  cert based on the user's email domain.
- **Subdomain mail provisioning** — mail-enabled subdomains write records
  into the managed parent zone under prefixed names (`mail.app`,
  `_dmarc.app`, etc.).

#### Apps & Databases
- **Database Browser** — phpMyAdmin-equivalent: paginated row view,
  structure (columns / indexes / engine), free-form SQL runner, audit-
  logged queries.
- **Node / Python App Manager** — PM2-backed process management with
  Apache reverse proxy, auto port allocation in 3000–3999, live logs,
  Restart / Stop / Start / Destroy controls.
- **WordPress install via job queue** — long-running install now async
  with progress reporting.

#### System
- **Domain Health Dashboard** — per-domain aggregator: SSL, DNS, Mail
  Health, backups, disk usage, PHP version, Apache error count. Surfaces
  the worst status as the overall summary.
- **Backup Restore** — restore files or databases from the UI with a
  `RESTORE` type-to-confirm guard, wipe-target / drop-recreate options.
  Audit-logged.
- **File Manager — chmod, archive extract, bulk delete + move, image
  preview**. Permissions column inline editor; supports `.zip`,
  `.tar.gz`, `.tar.bz2`, `.tar`.
- **Notifications** — email alerts for SSL expiry (< 14 days), Mail
  Health probe failures, backup failures, new-admin-IP logins. Dedup'd
  for 24 hours. Logged to `dpanel_notifications`.
- **Job Queue** — in-process queue with progress + log per job, polled
  via `/api/jobs/:id`. Currently powers WordPress install.

#### UX
- **Responsive / Mobile** — sidebar collapses to off-screen below 768px
  with a hamburger toggle. Tables progressively hide low-priority
  columns at 1100/900/820/700/640/560/480px breakpoints. Modals turn
  into full-width bottom sheets on phones. Touch-target enlargement on
  `(pointer: coarse)` devices. DB Browser sidebar collapses above main
  pane on narrow screens.
- **Changelog modal** — click the version pill in the sidebar.
- **User Guide link** in the sidebar footer.

### Changed

- **Atomic domain provisioning** — `routes/domains.js` POST flow replaced
  with a 13-step reconciler in `lib/state/domain.js`. Each step has
  `check`, `apply`, and a rollback closure. On partial failure, all prior
  steps are rolled back in reverse.
- **Apache `deleteVhost`** now also removes the certbot-generated
  `-le-ssl.conf` twin.
- **`setupMailDns`** now writes MTA-STS / TLS-RPT records in addition to
  the existing MX/SPF/DMARC; correctly handles subdomain provisioning by
  walking up to the managed parent zone.
- **`dns.js SERVER_IP`** — previously hardcoded to the production IP;
  now auto-detected via `hostname -I`, with `DPANEL_SERVER_IP` env var
  override.
- **WebSocket terminal session check** — already used DB-backed sessions
  cleanly; no functional change.

### Fixed

- **🚨 Empty database backups (critical)** — `lib/mysql.js dumpDatabase`
  invoked `mysqldump ... \`${name}\` ...` in a shell string, which the
  shell interpreted as command substitution. `mysqldump` was running
  with no database argument and producing 20-byte empty gzip streams.
  Every database backup taken in production since the original release
  was affected.
- **Webmail / autoconfig vhost collision** — the autoconfig vhost
  claimed `webmail.<domain>` as a `ServerAlias`, intercepting webmail
  traffic and returning 403 (Apache picked whichever vhost loaded first
  alphabetically). Fixed at the source + added a vhost collision guard
  that refuses new vhosts whose hostnames overlap an existing one.
- **Webmail vhost ACME exemption** — the `ProxyPass /` directive
  swallowed Let's Encrypt http-01 challenges, silently breaking cert
  renewals. New webmail vhosts include an `Alias` + `ProxyPass !`
  exemption for `/.well-known/acme-challenge/`.
- **Maildir literal-brace bug** — `mkdir -p .../Maildir/{cur,new,tmp}`
  was creating a literal directory named `{cur,new,tmp}` because
  `execSync` runs through `/bin/sh` (dash), which doesn't brace-expand.
- **Missing npm dependencies** — `helmet`, `dotenv`, `cookie`,
  `cookie-signature`, `geoip-lite`, `isbot` were `require()`'d but not
  declared in `package.json`. Fresh installs crashed on boot.
- **Admin email reading deleted config.json** — `getAdminEmail()`
  read from `config.json` (renamed to `.migrated` after the DB
  migration), so Let's Encrypt registrations used the `admin@<newdomain>`
  fallback. Now reads from `dpanel_users.email`.
- **Dovecot users file format** — entries written with non-numeric UID
  columns; newer Dovecot rejects. Fixed format + Dovecot config uses
  `override_fields` for backwards compatibility with legacy entries.

### Security
- Disable-2FA endpoint requires the current password (anti-hijack).
- API keys never returned by list endpoint — only the prefix is stored.
- Bcrypt cost factor 12.
- Session cookies set `sameSite=strict`, `secure=true`, `httpOnly=true`.

### Migration notes
- New env vars: `DPANEL_SERVER_IP` (recommended explicit set),
  `DPANEL_MAIL_HOSTNAME` (optional override for Postfix HELO),
  `DMARC_INBOX_EMAIL/PASSWORD` (DMARC processor, optional),
  `DPANEL_SEED_<PROVIDER>` + `_PASSWORD` (seed list deliverability test,
  optional).
- Run `npm install` after pulling (new deps) and `npm install -g pm2`
  (required for the App Manager).
- Existing webmail vhosts on production servers need an ACME exemption
  patch — see `PROD_MIGRATIONS.md`.
- Existing database backups created before this release are likely
  empty; check `find /opt/dpanel/backups -name "*_db_*.sql.gz" -size
  -100c` and recreate any matches.

---

## [1.0.0] – 2026-04

Initial release. Self-hosted control panel covering domains, DNS, mail,
files, databases, cron, firewall, analytics, terminal, and basic user
management.
