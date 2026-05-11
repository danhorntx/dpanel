# DPanel — Architecture Decisions

Append-only log of significant decisions. Each entry: date, decision, why, alternatives considered.

---

## 2026-05-10 — Strategic direction: strangler-fig modernization, not greenfield rewrite

**Decision:** Modernize DPanel in place rather than rewrite from scratch. Build new pieces alongside the existing app, replace the old pieces one feature at a time.

**Why:**
- Existing code is reasonable: short files, consistent style, good lib/route separation. Issues are architectural gaps, not code quality.
- 9 live client domains can't be disrupted. Strangler-fig preserves the proven code path while new pieces are validated.
- "Cheap cPanel alternative" goal is reachable in 6–12 months via incremental modernization. Greenfield is a 12–18 month project that historically gets abandoned.
- The three pain points (domain setup, webmail, deliverability) can be fixed in place — none of them require a stack swap.

**Alternatives considered:**
- *Greenfield rewrite (TypeScript + Fastify + SvelteKit + Stalwart)*: Rejected. Doesn't fix mail deliverability (same VPS, same IP). Months of work before any value ships. High abandonment risk.
- *Polish only (execute the May audit's Sprints 1–6)*: Rejected. Doesn't address vhost collisions, fire-and-forget provisioning, or the monolithic 3,239-line dashboard.html. Locks in current architecture.

---

## 2026-05-10 — Mail stays entirely on the VPS — no external relay

**Decision:** All mail (inbound + outbound) is served by the VPS's Postfix/Dovecot/OpenDKIM stack. No Postmark, Mailgun, or SES relay.

**Why:**
- Operator (Dan) does not want recurring cost for mail.
- Self-hosted mail is achievable to ~95% Gmail-inbox quality (Mail-in-a-Box-class) with discipline around rDNS, HELO, MTA-STS, DKIM/SPF/DMARC alignment, RBL hygiene.

**Tradeoffs accepted:**
- Mail Health probe becomes load-bearing — without it we're blind. Daily checks for rDNS, RBL listing, MTA-STS, DMARC alignment, test-send verification.
- IP reputation work is ours: if <server-1-ip> ends up on Spamhaus PBL/SBL (Contabo IPs often do), we either request delisting or request a new IP from Contabo.
- IP warmup discipline: don't blast large volumes from a cold IP.

**Revisit if:** Deliverability remains below ~85% Gmail-inbox after Mail Health + remediation tickets ship and we've exhausted RBL/warmup options. At that point, optional per-domain "Use relay" toggle becomes the escape hatch.

---

## 2026-05-10 — Staging server at <server-2-ip> (Contabo, Ubuntu 24.04)

**Decision:** Dedicated staging VPS, fresh install. Hostname `staging.danhorntx.com`. Panel reachable at `https://<ip>:8080` with self-signed cert (mirrors prod's panel URL pattern). Test domain `danhorntxtest.com` (registered fresh) used as the end-to-end provisioning target.

**Why:**
- Production VPS hosts 9 live client sites + email. Cannot be the test target.
- Same OS family as prod (Ubuntu) — but newer (24.04 vs prod's 22.04). Phase 1 will validate the install path works on 24.04, and a future ticket migrates prod.
- Direct push-to-staging without PR review (operator's call); production deploys still gate behind operator's manual command.

**Bootstrap:** `setup-staging.sh` at repo root.

---

## 2026-05-10 — SSH hardened to key-only on staging

**Decision:** Disabled password auth on staging (PasswordAuthentication no in `/etc/ssh/sshd_config.d/50-cloud-init.conf` + `99-dpanel-staging.conf`). Key-only via `staging-vps.key` (ed25519).

**Why:** Standard practice. Original Contabo password leaked into the Claude transcript while diagnosing a key file — operator was asked to rotate it in the Contabo panel as belt-and-suspenders.

---

## 2026-05-11 — Mail Health probe as the core deliverability surface

**Decision:** Build `lib/mailhealth.js` as a single source of truth for "is my mail actually deliverable from this server?" — checks all the deliverability prerequisites receiving MTAs actually look at, returns a structured per-check result, surfaces in UI under Mail → Health. Run on demand and via a daily cron.

**Why:**
- Owner committed to all-mail-on-VPS (no relay), which makes deliverability a *visibility* problem: you can't fix what you can't see.
- Per-check granular result + remediation hints lets the operator act on the specific failure instead of guessing.
- Daily cron + trending in `dpanel_mail_health` answers "did the fix help?" without a separate dashboard.

**What it checks** (11 things): rDNS forward-confirm, HELO/myhostname match, mail.<domain> A record, MX, SPF, DKIM (with local key match), DMARC, MTA-STS DNS+policy, TLS-RPT, IMAP TLS cert match, RBL (Spamhaus + Sorbs + Barracuda + SpamCop).

**Alternatives considered:**
- *External service (e.g. MXToolbox API, Postmark deliverability)*: Rejected. Recurring cost, dependency on third-party, less granular for our specific stack.
- *Manual diagnostic playbook*: Rejected. Doesn't scale across 9 prod domains + future clients, no trending.

**Revisit if:** Probe runs hit rate limits at the RBL services (Spamhaus charges for high-volume queries). Then we batch/cache results.

---

## 2026-05-11 — 2FA: TOTP from scratch + no backup codes (for now)

**Decision:** Implement RFC 6238 TOTP in-house (`lib/totp.js`) rather than pull a dep, and skip recovery/backup codes in v1.

**Why TOTP from scratch:**
- ~70 lines of HMAC-SHA1 + base32. Node's crypto has both built-in.
- No new dependency surface for a primitive that hasn't meaningfully changed in 20 years.
- We DO use `qrcode` for QR rendering — the spec for that is too painful to reimplement.

**Why no backup codes (yet):**
- For a single-admin panel (operator's own VPS), recovery is "SSH to box, `UPDATE dpanel_users SET totp_enabled=0`". Fast and direct.
- Backup codes add complexity: encrypted at rest, single-use, regeneration UX. ~2h of work that doesn't earn its keep for solo admin.

**Revisit when:**
- We add non-admin users with 2FA, OR
- The panel goes open-source and randoms need a self-serve recovery path.

---

## 2026-05-11 — MTA-STS in "testing" mode by default, not "enforce"

**Decision:** Auto-publish MTA-STS at policy `mode: testing` for every mail-enabled domain. Operator graduates to `enforce` manually after Mail Health probe shows it green for at least a week.

**Why:**
- `enforce` mode lets receivers REFUSE delivery if TLS verification fails. A misconfigured policy file or a stale cert silently breaks inbound mail.
- `testing` mode advertises the policy but receivers continue with opportunistic TLS. Failures generate TLS-RPT reports (useful for diagnosis) without blocking delivery.
- The probe surfaces whether the policy is reachable and valid; once stable, graduation is a one-line change to the policy file.

**Revisit if:** A prod domain has been in `testing` for >30 days with the probe consistently passing — graduate that domain to `enforce`.

---

## Decision template (for future entries)

```
## YYYY-MM-DD — Short title

**Decision:** What we're doing.

**Why:**
- Bullet reasoning.

**Alternatives considered:**
- *Name*: Brief description. Why rejected.

**Revisit if:** Conditions that would change the call.
```
