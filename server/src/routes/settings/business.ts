import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, Prisma } from '../../db.js'
import { audit } from '../../lib/audit.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { brandingFor } from '../../lib/branding.js'
import { forgetTenant } from '../../lib/tenant.js'
import { body } from '../../lib/validate.js'
import { requireRole, type AppEnv } from '../../middleware/auth.js'

// Mounted at /api/admin by ../settings.ts. Paths here are relative to /api/admin.
export const businessRoutes = new Hono<AppEnv>()

// What the owner edits and what the receipt prints.
const businessSelect = {
  id: true,
  name: true,
  legalName: true,
  email: true,
  phone: true,
  address: true,
  kraPin: true,
  receiptFooter: true,
  vatRateBps: true,
  trackStock: true,
  requireMpesaCode: true,
  brandColor: true,
  brandTheme: true
} as const

// Optional text: trimmed, and an empty string (or null) clears the field.
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} is at most ${max} characters`)
    .nullable()
    .transform(s => (s === '' ? null : s))

const emailRule = z.email()
const KRA_PIN = /^[A-Z]\d{9}[A-Z]$/
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #1f6feb').transform(s => s.toLowerCase())

const patchSchema = z
  .object({
    name: z.string().trim().min(2, 'Business name is too short').max(80, 'Business name is at most 80 characters'),
    legalName: text(120, 'Legal name'),
    email: z
      .string()
      .trim()
      .max(120, 'Email is at most 120 characters')
      .refine(s => s === '' || emailRule.safeParse(s).success, 'Enter a valid email address')
      .nullable()
      .transform(s => (s === '' ? null : s)),
    // free text on purpose: a shop landline or mobile, printed as typed
    phone: text(40, 'Phone'),
    address: text(200, 'Address'),
    kraPin: z
      .string()
      .trim()
      .toUpperCase()
      .refine(s => s === '' || KRA_PIN.test(s), 'KRA PIN is a letter, 9 digits and a letter, for example A123456789Z')
      .nullable()
      .transform(s => (s === '' ? null : s)),
    receiptFooter: text(200, 'Receipt footer'),
    // 0 for a shop that is not registered for VAT
    vatRateBps: z.number().int('VAT rate must be a whole number of basis points').min(0).max(5000, 'VAT rate is at most 5000 (50%)'),
    trackStock: z.boolean(),
    requireMpesaCode: z.boolean(),
    // the till's accent colour, picked from the logo; null goes back to brass
    brandColor: hex.nullable(),
    // a colour for each part of the till; parts left out follow buttons. null: brass
    brandTheme: z
      .object({ buttons: hex, highlights: hex.nullable().optional(), text: hex.nullable().optional(), glow: hex.nullable().optional() })
      .strict()
      .transform(t => Object.fromEntries(Object.entries(t).filter(([, v]) => v)) as { buttons: string })
      .nullable()
  })
  .partial()
  .refine(v => Object.values(v).some(x => x !== undefined), 'Nothing to change')

type Field = Exclude<keyof typeof businessSelect, 'id'>
const FIELDS = Object.keys(businessSelect).filter(k => k !== 'id') as Field[]

// ---------- logo ----------

const MAX_LOGO_BYTES = 70_000
const logoBody = z.object({ image: z.string().max(100_000) })

// PNG, JPEG or WebP only, recognised by their first bytes. No SVG: it can
// carry script.
function imageType(b: Buffer) {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

// The till shrinks the image before sending it (at most 512 pixels a side).
businessRoutes.put('/business/logo', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const { image } = await body(c, logoBody)
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image)
  if (!m) throw badRequest('Upload a PNG, JPEG or WebP image.')
  const bytes = Buffer.from(m[2]!, 'base64')
  const type = imageType(bytes)
  if (!type) throw badRequest('That file is not a PNG, JPEG or WebP image.')
  if (bytes.length > MAX_LOGO_BYTES) throw badRequest('The logo is too large. Use a smaller image.')
  const at = new Date()
  await prisma.$transaction(async tx => {
    await tx.business.update({ where: { id: actor.businessId }, data: { logo: bytes, logoType: type, logoUpdatedAt: at } })
    await audit(tx, actor, 'business.logo_uploaded', 'business', actor.businessId, { bytes: bytes.length, type })
  })
  forgetTenant()
  return c.json({ branding: await brandingFor(actor.businessId) })
})

businessRoutes.delete('/business/logo', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  await prisma.$transaction(async tx => {
    await tx.business.update({ where: { id: actor.businessId }, data: { logo: null, logoType: null, logoUpdatedAt: null } })
    await audit(tx, actor, 'business.logo_removed', 'business', actor.businessId)
  })
  forgetTenant()
  return c.json({ branding: await brandingFor(actor.businessId) })
})

businessRoutes.get('/business', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const business = await prisma.business.findUnique({ where: { id: actor.businessId }, select: businessSelect })
  if (!business) throw notFound('Business')
  return c.json({ business })
})

businessRoutes.patch('/business', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, patchSchema)
  const business = await prisma.$transaction(async tx => {
    // Two owners saving at once: the second one must compare against what the
    // first one wrote, or the audit trail would name the wrong fields.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Business" WHERE id = ${actor.businessId} FOR UPDATE`
    if (!locked.length) throw notFound('Business')
    const before = await tx.business.findUniqueOrThrow({ where: { id: actor.businessId }, select: businessSelect })
    // the colour set and the button colour always agree
    if (input.brandTheme !== undefined) input.brandColor = input.brandTheme?.buttons ?? null
    else if (input.brandColor !== undefined) (input as Record<string, unknown>).brandTheme = input.brandColor ? { buttons: input.brandColor } : null
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    const fields = FIELDS.filter(k => input[k] !== undefined && !same(input[k], before[k]))
    if (!fields.length) return before
    const pick = (src: Partial<Record<Field, unknown>>) => Object.fromEntries(fields.map(k => [k, src[k] ?? null]))
    const data = pick(input) as Record<string, unknown>
    if ('brandTheme' in data && data.brandTheme === null) data.brandTheme = Prisma.DbNull
    const after = await tx.business.update({ where: { id: actor.businessId }, data: data as never, select: businessSelect })
    await audit(tx, actor, 'business.updated', 'business', after.id, { fields, from: pick(before), to: pick(after) })
    return after
  })
  return c.json({ business })
})
