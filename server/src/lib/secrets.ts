import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { env } from '../env.js'

// Encrypts small secrets (a client's M-Pesa keys) before they go into the
// database. AES-256-GCM with a random nonce per value. The key comes from
// SECRETS_KEY, or is derived from BETTER_AUTH_SECRET when that is not set.
// Stored as: v1.<nonce>.<tag>.<ciphertext>, each part base64url.

const key = Buffer.from(
  hkdfSync('sha256', Buffer.from(env.SECRETS_KEY ?? env.BETTER_AUTH_SECRET), Buffer.alloc(0), Buffer.from('bottle-point/secrets/v1'), 32)
)

export function encryptSecret(plain: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

export function decryptSecret(stored: string): string {
  const [version, nonce, tag, data] = stored.split('.')
  if (version !== 'v1' || !nonce || !tag || data === undefined) throw new Error('Unreadable secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

// What the API may show about a stored secret: that it exists and its last
// characters, never the value.
export function secretHint(stored: string | null | undefined): string | null {
  if (!stored) return null
  try {
    const plain = decryptSecret(stored)
    return plain.length > 6 ? '••••' + plain.slice(-4) : '••••'
  } catch {
    return null
  }
}
