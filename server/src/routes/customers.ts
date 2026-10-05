import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, Prisma, type Customer } from '../db.js'
import { audit } from '../lib/audit.js'
import { conflict, notFound } from '../lib/errors.js'
import { body, id, parse, phone, query } from '../lib/validate.js'
import { requireRole, type Actor, type AppEnv } from '../middleware/auth.js'

export const customerRoutes = new Hono<AppEnv>()

const name = z.string().trim().min(1, 'Name is required').max(80)
const createSchema = z.object({ name, phone: phone.nullable().optional() })
const patchSchema = z
  .object({ name: name.optional(), phone: phone.nullable().optional() })
  .refine(v => Object.keys(v).length > 0, 'Nothing to change')
const listQuery = z.object({ q: z.string().trim().max(80).optional() })

const duplicatePhone = () => conflict('Another customer already has this phone number.', 'duplicate_phone')

function isUniqueError(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

type Stats = { spentCents: number; visitCount: number; lastVisitAt: Date | null; openTabCents: number; openSales: number }

// Lifetime spend is what paid sales came to. The open tab is what is still
// owed on saved (unpaid) sales.
async function statsFor(customerIds: string[]): Promise<Map<string, Stats>> {
  const out = new Map<string, Stats>()
  for (const cid of customerIds) out.set(cid, { spentCents: 0, visitCount: 0, lastVisitAt: null, openTabCents: 0, openSales: 0 })
  if (!customerIds.length) return out
  const sales = await prisma.sale.findMany({
    where: { customerId: { in: customerIds }, status: { in: ['PAID', 'SAVED'] } },
    select: { customerId: true, status: true, totalCents: true, createdAt: true, payments: { select: { amountCents: true } } }
  })
  for (const s of sales) {
    const st = out.get(s.customerId!)!
    if (!st.lastVisitAt || s.createdAt > st.lastVisitAt) st.lastVisitAt = s.createdAt
    if (s.status === 'PAID') {
      st.spentCents += s.totalCents
      st.visitCount += 1
    } else {
      const paid = s.payments.reduce((a, p) => a + p.amountCents, 0)
      st.openTabCents += Math.max(0, s.totalCents - paid)
      st.openSales += 1
    }
  }
  return out
}

const toDTO = (cu: Customer, st?: Stats) => ({
  id: cu.id,
  name: cu.name,
  phone: cu.phone,
  createdAt: cu.createdAt,
  ...(st ?? {})
})

async function loadCustomer(actor: Actor, customerId: string) {
  const cu = await prisma.customer.findFirst({ where: { id: customerId, businessId: actor.businessId } })
  if (!cu) throw notFound('Customer')
  return cu
}

customerRoutes.get('/', async c => {
  const actor = c.get('actor')
  const q = query(c, listQuery)
  const where: Prisma.CustomerWhereInput = { businessId: actor.businessId }
  if (q.q) {
    const or: Prisma.CustomerWhereInput[] = [{ name: { contains: q.q, mode: 'insensitive' } }]
    const digits = q.q.replace(/\D/g, '')
    if (digits.length >= 3) {
      or.push({ phone: { contains: digits } })
      if (digits.startsWith('0')) or.push({ phone: { contains: '254' + digits.slice(1) } })
    }
    where.OR = or
  }
  const customers = await prisma.customer.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 100 })
  const stats = await statsFor(customers.map(cu => cu.id))
  return c.json({ customers: customers.map(cu => toDTO(cu, stats.get(cu.id))) })
})

customerRoutes.get('/:id', async c => {
  const actor = c.get('actor')
  const cu = await loadCustomer(actor, parse(id, c.req.param('id')))
  const stats = await statsFor([cu.id])
  return c.json({ customer: toDTO(cu, stats.get(cu.id)) })
})

customerRoutes.post('/', async c => {
  const actor = c.get('actor')
  const input = await body(c, createSchema)
  if (input.phone) {
    const taken = await prisma.customer.findFirst({ where: { businessId: actor.businessId, phone: input.phone } })
    if (taken) throw duplicatePhone()
  }
  try {
    const customer = await prisma.$transaction(async tx => {
      const cu = await tx.customer.create({ data: { businessId: actor.businessId, name: input.name, phone: input.phone ?? null } })
      await audit(tx, actor, 'customer.created', 'customer', cu.id, { name: cu.name, phone: cu.phone })
      return cu
    })
    return c.json({ customer: toDTO(customer) }, 201)
  } catch (err) {
    if (isUniqueError(err)) throw duplicatePhone()
    throw err
  }
})

customerRoutes.patch('/:id', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const customerId = parse(id, c.req.param('id'))
  const input = await body(c, patchSchema)
  const before = await loadCustomer(actor, customerId)
  if (input.phone) {
    const taken = await prisma.customer.findFirst({ where: { businessId: actor.businessId, phone: input.phone, id: { not: customerId } } })
    if (taken) throw duplicatePhone()
  }
  try {
    const customer = await prisma.$transaction(async tx => {
      const cu = await tx.customer.update({ where: { id: customerId }, data: input })
      await audit(tx, actor, 'customer.updated', 'customer', cu.id, {
        from: { name: before.name, phone: before.phone },
        to: { name: cu.name, phone: cu.phone }
      })
      return cu
    })
    const stats = await statsFor([customer.id])
    return c.json({ customer: toDTO(customer, stats.get(customer.id)) })
  } catch (err) {
    if (isUniqueError(err)) throw duplicatePhone()
    throw err
  }
})
