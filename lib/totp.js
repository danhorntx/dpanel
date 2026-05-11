'use strict';
/**
 * lib/totp.js — RFC 6238 TOTP (Time-based One-Time Password).
 *
 * No external deps for the math: HMAC-SHA1 is in Node's crypto. We use a
 * 20-byte base32 secret, 30-second time step, 6 digits, ±1 step verification
 * tolerance (≈30s clock drift). That's the default Google/Authy/1Password
 * implement.
 *
 * Public API:
 *   generateSecret()                    → 32-char base32 string
 *   generateUri(secret, label, issuer)  → otpauth://totp/... (QR-friendly)
 *   verify(secret, token, window=1)     → boolean
 *   generate(secret, time?)             → 6-digit string (mostly for tests)
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS    = 30;
const DIGITS          = 6;

// ── Base32 (RFC 4648) ─────────────────────────────────────────────────────────

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const cleaned = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Generate a fresh 160-bit base32 secret. Matches Google Authenticator
 * expectations (32 base32 chars = 160 bits = 20 bytes).
 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Build the otpauth:// URI an authenticator scans. Per spec:
 *   otpauth://totp/<issuer>:<label>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
 */
function generateUri(secret, label, issuer = 'DPanel') {
  const enc = encodeURIComponent;
  const labelStr = `${enc(issuer)}:${enc(label)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits:    String(DIGITS),
    period:    String(STEP_SECONDS),
  });
  return `otpauth://totp/${labelStr}?${params.toString()}`;
}

/**
 * Generate the 6-digit token for the given secret at the given time
 * (defaults to "now"). Exposed for testing — verify() is what callers should
 * normally use because it handles the ±window tolerance.
 */
function generate(secret, timeMs = Date.now()) {
  const key  = base32Decode(secret);
  const step = Math.floor(timeMs / 1000 / STEP_SECONDS);

  // 8-byte big-endian step counter
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step), 0);

  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation (RFC 4226 §5.3)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = ((hmac[offset]     & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) <<  8) |
                 ( hmac[offset + 3] & 0xff);
  return String(code % (10 ** DIGITS)).padStart(DIGITS, '0');
}

/**
 * Constant-time check the user-supplied token against generated tokens at
 * step-0, step-±1, ..., step-±window. Returns true on any match.
 *
 * window=1 (default) tolerates ~30s clock drift either direction. Larger
 * windows weaken security; don't go above 2 without thinking.
 */
function verify(secret, token, window = 1) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return false;
  const now = Date.now();
  for (let delta = -window; delta <= window; delta++) {
    const expected = generate(secret, now + delta * STEP_SECONDS * 1000);
    if (timingSafeEqual(expected, token)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { generateSecret, generateUri, generate, verify, base32Encode, base32Decode };
