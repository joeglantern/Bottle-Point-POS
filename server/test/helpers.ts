import { createApp } from '../src/app.js'
import { prisma } from '../src/db.js'
import { createPlatformUser, createStaff } from '../src/lib/users.js'

export const app = createApp()
export const ORIGIN = 'http://localhost:5173'

// Wipe every table (TRUNCATE skips the append only trigger on AuditLog).
export async function resetDb() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  const list = rows.map(r => `"public"."${r.tablename}"`).join(', ')
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
}

export const PIN = '1234'

// A small business with two branches, staff in each and stocked products.
export async function seedFixture() {
  const business = await prisma.business.create({ data: { name: 'Test Wines' } })
  const west = await prisma.branch.create({ data: { businessId: business.id, name: 'Westlands' } })
  const kili = await prisma.branch.create({ data: { businessId: business.id, name: 'Kilimani' } })

  const mk = (username: string, role: 'CASHIER' | 'MANAGER' | 'OWNER', branchIds: string[]) =>
    createStaff(prisma, { businessId: business.id, name: username, username, pin: PIN, role, branchIds })

  const cashier = await mk('cashier', 'CASHIER', [west.id])
  const cashier2 = await mk('cashier2', 'CASHIER', [west.id])
  const manager = await mk('manager', 'MANAGER', [west.id])
  const kiliCashier = await mk('kilicashier', 'CASHIER', [kili.id])
  const kiliManager = await mk('kilimanager', 'MANAGER', [kili.id])
  const owner = await mk('owner', 'OWNER', [])

  const product = (name: string, barcode: string, priceCents: number, category = 'Whisky') =>
    prisma.product.create({ data: { businessId: business.id, name, barcode, priceCents, category, sizeMl: 750 } })
  const whisky = await product('Johnnie Walker Black', '5000267024004', 480000)
  const beer = await product('Tusker Lager', '6161100010017', 28000, 'Beer')
  const gin = await product('Gilbeys Gin', '6161101560203', 145000, 'Gin')

  for (const b of [west, kili]) {
    for (const p of [whisky, beer, gin]) {
      await prisma.stock.create({ data: { branchId: b.id, productId: p.id, qty: 50 } })
    }
  }

  return {
    business,
    branches: { west, kili },
    users: { cashier, cashier2, manager, kiliCashier, kiliManager, owner },
    products: { whisky, beer, gin }
  }
}
export type Fixture = Awaited<ReturnType<typeof seedFixture>>

export type Res<T = any> = { status: number; body: T }

// A signed in client for one user. Keeps the session cookie.
export class Client {
  constructor(public cookie = '', public branchId?: string) {}

  static async login(username: string, pin = PIN, branchId?: string) {
    const res = await app.request('/api/session/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username, pin })
    })
    if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`)
    const cookie = res.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .join('; ')
    return new Client(cookie, branchId)
  }

  async req<T = any>(method: string, path: string, json?: unknown): Promise<Res<T>> {
    const headers: Record<string, string> = { origin: ORIGIN, cookie: this.cookie }
    if (this.branchId) headers['x-branch-id'] = this.branchId
    if (json !== undefined) headers['content-type'] = 'application/json'
    const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) })
    const text = await res.text()
    let body: any = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, body }
  }
  get<T = any>(p: string) {
    return this.req<T>('GET', p)
  }
  post<T = any>(p: string, j: unknown = {}) {
    return this.req<T>('POST', p, j)
  }
  patch<T = any>(p: string, j: unknown = {}) {
    return this.req<T>('PATCH', p, j)
  }
  put<T = any>(p: string, j: unknown = {}) {
    return this.req<T>('PUT', p, j)
  }
  del<T = any>(p: string) {
    return this.req<T>('DELETE', p)
  }
}

export const CONSOLE_PASSWORD = 'correct-horse-battery'

// One console user per platform role.
export async function seedPlatform() {
  const mk = (name: string, role: 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING') =>
    createPlatformUser(prisma, { name, email: `${name}@bottlepoint.test`, password: CONSOLE_PASSWORD, role })
  return { admin: await mk('admin', 'SUPER_ADMIN'), support: await mk('support', 'SUPPORT'), billing: await mk('billing', 'BILLING') }
}

// A signed in console client. Same request helpers as Client.
export async function consoleLogin(email: string, password = CONSOLE_PASSWORD) {
  const res = await app.request('/api/console/session/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password })
  })
  if (res.status !== 200) throw new Error(`console login ${email} failed: ${res.status} ${await res.text()}`)
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return new Client(cookie)
}
