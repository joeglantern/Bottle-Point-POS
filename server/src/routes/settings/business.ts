import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../../db.js'
import { audit } from '../../lib/audit.js'
import { notFound } from '../../lib/errors.js'
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
  vatRateBps: true
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
    vatRateBps: z.number().int('VAT rate must be a whole number of basis points').min(0).max(5000, 'VAT rate is at most 5000 (50%)')
  })
  .partial()
  .refine(v => Object.values(v).some(x => x !== undefined), 'Nothing to change')

type Field = Exclude<keyof typeof businessSelect, 'id'>
const FIELDS = Object.keys(businessSelect).filter(k => k !== 'id') as Field[]

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
    const fields = FIELDS.filter(k => input[k] !== undefined && input[k] !== before[k])
    if (!fields.length) return before
    const pick = (src: Partial<Record<Field, string | number | null>>) => Object.fromEntries(fields.map(k => [k, src[k] ?? null]))
    const after = await tx.business.update({ where: { id: actor.businessId }, data: pick(input), select: businessSelect })
    await audit(tx, actor, 'business.updated', 'business', after.id, { fields, from: pick(before), to: pick(after) })
    return after
  })
  return c.json({ business })
})
