import crypto from 'crypto'
import { config } from './config.js'

// AES-256-GCM sealing for the session cookie. The cookie holds the user's
// IMAP password — losing the encryption key invalidates all sessions but
// does not leak passwords (they live encrypted-at-rest only inside the cookie
// itself, never on disk).

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  if (!config.cookieSecret) {
    throw new Error('DPANEL_COOKIE_SECRET is required in DPanel mode')
  }
  // Accept either a 64-hex-char key (32 bytes) or any string we hash to 32 bytes.
  if (/^[0-9a-f]{64}$/i.test(config.cookieSecret)) {
    return Buffer.from(config.cookieSecret, 'hex')
  }
  return crypto.createHash('sha256').update(config.cookieSecret).digest()
}

export interface SessionPayload {
  accountId: string
  email: string
  name: string
  username: string
  // Password is sealed inside the cookie itself; once decoded it is held only
  // in the in-memory accountStore, never persisted.
  password: string
  imapHost: string
  imapPort: number
  imapTls: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  issuedAt: number
}

export function seal(payload: SessionPayload): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALG, key, iv)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  // [iv | tag | ciphertext]
  return Buffer.concat([iv, tag, enc]).toString('base64url')
}

export function unseal(token: string): SessionPayload | null {
  try {
    const key = getKey()
    const buf = Buffer.from(token, 'base64url')
    if (buf.length < IV_LEN + TAG_LEN + 1) return null
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ct = buf.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv(ALG, key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    return JSON.parse(plaintext) as SessionPayload
  } catch {
    return null
  }
}

export function accountIdFor(email: string): string {
  const norm = email.trim().toLowerCase()
  return 'dp_' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)
}
