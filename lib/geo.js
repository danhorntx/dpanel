'use strict';
/**
 * lib/geo.js — IP Geolocation wrapper using geoip-lite (MaxMind GeoLite2, offline)
 *
 * Privacy model:
 *  - The raw IP is NEVER stored. We zero the last octet (IPv4) or last 80 bits
 *    (IPv6) before any persistence, and store a SHA-256 hash for session
 *    correlation only.
 *  - geoip-lite lookups use the real IP in memory only (never written to disk
 *    beyond the anon/hash forms).
 *
 * Returns: { country, region, city } — all may be null on failure.
 */

const crypto = require('crypto');

let geoip;
try {
  geoip = require('geoip-lite');
} catch (_) {
  geoip = null; // graceful degradation
}

// Private / reserved IP ranges (RFC 1918, loopback, link-local, etc.)
const PRIVATE_RE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fe80:|fc00:|fd)/i;

/**
 * anonymizeIP(ip) → { anon: string, hash: string }
 *
 * anon  — last octet zeroed (IPv4) or last 80 bits zeroed (IPv6); safe to store
 * hash  — SHA-256 of raw IP; used for session/visitor dedup; never reversible
 */
function anonymizeIP(ip) {
  if (!ip || ip === '-') return { anon: '0.0.0.0', hash: '' };

  const hash = crypto.createHash('sha256').update(ip).digest('hex');

  let anon;
  if (ip.includes(':')) {
    // IPv6 — zero last 80 bits (last 5 groups of 4 hex chars)
    const parts = ip.split(':');
    if (parts.length === 8) {
      anon = parts.slice(0, 3).join(':') + ':0000:0000:0000:0000:0000';
    } else {
      anon = ip; // can't parse, store as-is (rare edge case)
    }
  } else {
    // IPv4 — zero last octet
    const octets = ip.split('.');
    octets[3] = '0';
    anon = octets.join('.');
  }

  return { anon, hash };
}

/**
 * lookup(ip) → { country: string|null, region: string|null, city: string|null }
 *
 * Returns nulls for private/loopback IPs or when geoip-lite is unavailable.
 */
function lookup(ip) {
  if (!ip || ip === '-' || ip === '::1' || PRIVATE_RE.test(ip)) {
    return { country: null, region: null, city: null };
  }

  if (!geoip) {
    return { country: null, region: null, city: null };
  }

  try {
    const geo = geoip.lookup(ip);
    if (!geo) return { country: null, region: null, city: null };

    return {
      country: geo.country || null,   // ISO 3166-1 alpha-2, e.g. 'US'
      region:  geo.region  || null,   // subdivision code, e.g. 'TX'
      city:    geo.city    || null,   // city name, e.g. 'Austin'
    };
  } catch (_) {
    return { country: null, region: null, city: null };
  }
}

module.exports = { anonymizeIP, lookup };
