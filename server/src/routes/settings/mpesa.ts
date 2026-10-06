import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type MpesaConfig } from '../../db.js'
import { requireRole, type AppEnv } from '../../middleware/auth.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { body } from '../../lib/validate.js'
import { encryptSecret, secretHint } from '../../lib/secrets.js'
import { clientFromStored } from '../../lib/daraja.js'

// Mounted at /api/admin by ../settings.ts. Paths here are relative to /api/admin.
// Each shop can use its own Paybill or Till. The keys are stored encrypted and
// never leave the server: the API only ever shows a hint.
export const mpesaRoutes = new Hono<AppEnv>()

function toConfigDTO(row: MpesaConfig | null) {
  return {
    enabled: row?.enabled ?? false,
    mode: row?.mode ?? 'MOCK',
    shortcode: row?.shortcode ?? null,
    partyB: row?.partyB ?? null,
    transactionType: row?.transactionType ?? 'CustomerPayBillOnline',
    consumerKeyHint: secretHint(row?.consumerKeyEnc),
    consumerSecretHint: secretHint(row?.consumerSecretEnc),
    passkeyHint: secretHint(row?.passkeyEnc),
    updatedAt: row?.updatedAt ?? null,
    // no enabled settings of its own: the server wide M-Pesa settings apply
    usingPlatformDefault: !row?.enabled
  }
}

mpesaRoutes.get('/mpesa', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const row = await prisma.mpesaConfig.findUnique({ where: { businessId: actor.businessId } })
  return c.json({ config: toConfigDTO(row) })
})

// '' and null mean "not given": forms send empty fields for secrets they keep
const blank = (v: unknown) => (v === '' || v === null ? undefined : v)
const digits = (what: string, min: number, max: number) =>
  z.preprocess(blank, z.string().trim().regex(new RegExp(`^\\d{${min},${max}}$`), `${what} must be ${min} to ${max} digits`).optional())
const secret = z.preprocess(blank, z.string().trim().min(1).max(500).optional())

const putSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['MOCK', 'SANDBOX', 'PRODUCTION']),
  shortcode: digits('Shortcode', 5, 7),
  partyB: digits('Till number', 5, 10),
  transactionType: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']),
  consumerKey: secret,
  consumerSecret: secret,
  passkey: secret
})

// Writers of one business's settings wait for each other on the business row
// (the settings row may not exist yet, so it cannot be the lock).
const lockBusiness = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], businessId: string) =>
  tx.$queryRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR UPDATE`

mpesaRoutes.put('/mpesa', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, putSchema)

  const row = await prisma.$transaction(async tx => {
    await lockBusiness(tx, actor.businessId)
    const old = await tx.mpesaConfig.findUnique({ where: { businessId: actor.businessId } })

    const shortcode = input.shortcode ?? null
    const partyB = input.partyB ?? null
    if (input.transactionType === 'CustomerBuyGoodsOnline' && !partyB) {
      throw new AppError(422, 'party_b_required', 'Buy Goods needs the till number.', { missing: ['partyB'] })
    }
    if (input.enabled && input.mode !== 'MOCK') {
      const missing: string[] = []
      if (!shortcode) missing.push('shortcode')
      if (!input.consumerKey && !old?.consumerKeyEnc) missing.push('consumerKey')
      if (!input.consumerSecret && !old?.consumerSecretEnc) missing.push('consumerSecret')
      if (!input.passkey && !old?.passkeyEnc) missing.push('passkey')
      if (missing.length) {
        throw new AppError(422, 'mpesa_incomplete', `Cannot turn M-Pesa on yet. Still missing: ${missing.join(', ')}.`, { missing })
      }
    }

    // names only, never the values
    const changed: string[] = []
    if ((old?.enabled ?? false) !== input.enabled) changed.push('enabled')
    if ((old?.mode ?? 'MOCK') !== input.mode) changed.push('mode')
    if ((old?.shortcode ?? null) !== shortcode) changed.push('shortcode')
    if ((old?.partyB ?? null) !== partyB) changed.push('partyB')
    if ((old?.transactionType ?? 'CustomerPayBillOnline') !== input.transactionType) changed.push('transactionType')
    if (input.consumerKey) changed.push('consumerKey')
    if (input.consumerSecret) changed.push('consumerSecret')
    if (input.passkey) changed.push('passkey')

    const data = {
      enabled: input.enabled,
      mode: input.mode,
      shortcode,
      partyB,
      transactionType: input.transactionType,
      updatedById: actor.id,
      // omitted secrets keep the stored value
      ...(input.consumerKey ? { consumerKeyEnc: encryptSecret(input.consumerKey) } : {}),
      ...(input.consumerSecret ? { consumerSecretEnc: encryptSecret(input.consumerSecret) } : {}),
      ...(input.passkey ? { passkeyEnc: encryptSecret(input.passkey) } : {})
    }
    const saved = await tx.mpesaConfig.upsert({
      where: { businessId: actor.businessId },
      create: { businessId: actor.businessId, ...data },
      update: data
    })
    await audit(tx, actor, 'mpesa.config_updated', 'MpesaConfig', actor.businessId, { changed })
    return saved
  })
  return c.json({ config: toConfigDTO(row) })
})

mpesaRoutes.delete('/mpesa/secrets', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const row = await prisma.$transaction(async tx => {
    await lockBusiness(tx, actor.businessId)
    const old = await tx.mpesaConfig.findUnique({ where: { businessId: actor.businessId } })
    if (!old) return null
    const saved = await tx.mpesaConfig.update({
      where: { businessId: actor.businessId },
      data: { enabled: false, consumerKeyEnc: null, consumerSecretEnc: null, passkeyEnc: null, updatedById: actor.id }
    })
    await audit(tx, actor, 'mpesa.secrets_deleted', 'MpesaConfig', actor.businessId, { wasEnabled: old.enabled })
    return saved
  })
  return c.json({ config: toConfigDTO(row) })
})

// ---------- connection test ----------

const TEST_LIMIT = 5
const TEST_WINDOW_MS = 60_000
const testHits = new Map<string, number[]>()

// Tests start from a clean limiter.
export function resetMpesaTestLimit() {
  testHits.clear()
}

function takeTestSlot(businessId: string, now = Date.now()) {
  const recent = (testHits.get(businessId) ?? []).filter(t => now - t < TEST_WINDOW_MS)
  if (recent.length >= TEST_LIMIT) {
    testHits.set(businessId, recent)
    throw new AppError(429, 'rate_limited', 'Too many tests. Wait a minute and try again.')
  }
  recent.push(now)
  testHits.set(businessId, recent)
}

// Asks Safaricom for a token with the stored keys. Always answers 200 with
// { ok, message }: a refused key or a dead network is a failed test, not a
// server error.
mpesaRoutes.post('/mpesa/test', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  takeTestSlot(actor.businessId)
  const row = await prisma.mpesaConfig.findUnique({ where: { businessId: actor.businessId } })
  if (!row) return c.json({ ok: false, message: 'No M-Pesa settings are saved yet. Save them first, then test.' })
  if (row.mode === 'MOCK') {
    return c.json({ ok: true, message: 'This is a simulation. No real money moves and Safaricom is not contacted.' })
  }
  const missing: string[] = []
  if (!row.shortcode) missing.push('shortcode')
  if (!row.consumerKeyEnc) missing.push('consumerKey')
  if (!row.consumerSecretEnc) missing.push('consumerSecret')
  if (!row.passkeyEnc) missing.push('passkey')
  if (missing.length) return c.json({ ok: false, message: `Cannot test yet. Still missing: ${missing.join(', ')}.` })
  try {
    // a fresh client, so the test never answers from a cached token
    await clientFromStored(row).accessToken()
  } catch (err) {
    // AppError messages are written for people and never contain the keys
    const message = err instanceof AppError ? err.message : 'The test could not be completed. Try again.'
    return c.json({ ok: false, message })
  }
  const where = row.mode === 'SANDBOX' ? 'the Safaricom sandbox' : 'Safaricom'
  return c.json({ ok: true, message: `Connected to ${where}. The consumer key and secret work.` })
})
