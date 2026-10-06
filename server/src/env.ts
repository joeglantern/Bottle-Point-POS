import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),
  TRUSTED_ORIGINS: z.string().default('http://localhost:5173'),
  // Encrypts client secrets at rest (their M-Pesa keys). Falls back to a key
  // derived from BETTER_AUTH_SECRET. Changing either makes stored secrets unreadable.
  SECRETS_KEY: z.string().min(32).optional(),
  // VAT charged on the platform's own invoices to clients, in basis points
  PLATFORM_VAT_BPS: z.coerce.number().int().min(0).max(5000).default(1600),
  // Secure cookies need HTTPS. Defaults to on in production; set false only
  // while a server is reached over plain HTTP (no domain yet).
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  MPESA_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  MPESA_CONSUMER_KEY: z.string().default(''),
  MPESA_CONSUMER_SECRET: z.string().default(''),
  MPESA_SHORTCODE: z.string().default('174379'),
  MPESA_PASSKEY: z.string().default(''),
  MPESA_CALLBACK_URL: z.string().default('http://localhost:3000/api/mpesa/callback'),
  MPESA_CALLBACK_TOKEN: z.string().min(16, 'MPESA_CALLBACK_TOKEN must be at least 16 characters'),
  // CustomerPayBillOnline for a paybill, CustomerBuyGoodsOnline for a till number
  MPESA_TRANSACTION_TYPE: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']).default('CustomerPayBillOnline'),
  // Buy Goods sends money to the till number, not the shortcode. Empty means the shortcode.
  MPESA_PARTY_B: z.string().default(''),
  // mock mode only: delay before the fake Safaricom callback. 0 or less turns it off.
  MPESA_MOCK_DELAY_MS: z.coerce.number().int().default(2500)
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const trustedOrigins = env.TRUSTED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
export const isProd = env.NODE_ENV === 'production'
export const secureCookies = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd
