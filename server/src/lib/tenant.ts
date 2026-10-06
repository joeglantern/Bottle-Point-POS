// Which client a request is for, worked out from the address it came to.
//
// With TENANT_BASE_DOMAIN=pos.flarehub.co.ke, a request to
// nyrolix.pos.flarehub.co.ke belongs to the business whose slug is
// "nyrolix". Staff of one business can never sign in or act on another
// business's address. Without TENANT_BASE_DOMAIN (local development) there
// is no address check at all.

import type { Context } from 'hono'
import { prisma } from '../db.js'
import { env, trustedOrigins } from '../env.js'

export type Tenant = { id: string; name: string; slug: string }

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
// Names that must never become a client's address.
export const RESERVED_SLUGS = new Set([
  'www', 'console', 'admin', 'api', 'app', 'pos', 'mail', 'smtp', 'ftp', 'status', 'help', 'support',
  'billing', 'docs', 'blog', 'static', 'assets', 'cdn', 'auth', 'login', 'test', 'staging', 'dev'
])

export const tenantMode = () => !!env.TENANT_BASE_DOMAIN

// The host the browser used. Caddy and nginx in front pass Host through as
// the browser sent it. X-Forwarded-Host is deliberately ignored: a client
// could set it, and the shop a request belongs to must not be forgeable.
export function hostOf(headers: Headers): string {
  const raw = headers.get('host') ?? ''
  return raw.split(',')[0]!.trim().toLowerCase().replace(/:\d+$/, '')
}

// "nyrolix" for nyrolix.pos.flarehub.co.ke, null for anything else.
export function slugFromHost(host: string): string | null {
  const base = env.TENANT_BASE_DOMAIN
  if (!base) return null
  const suffix = '.' + base
  if (!host.endsWith(suffix)) return null
  const label = host.slice(0, -suffix.length)
  return SLUG_RE.test(label) && !RESERVED_SLUGS.has(label) ? label : null
}

// A short cache: every API request looks this up.
const cache = new Map<string, { tenant: Tenant | null; at: number }>()
const TTL_MS = 30_000

export async function tenantFromHeaders(headers: Headers): Promise<Tenant | null> {
  const slug = slugFromHost(hostOf(headers))
  if (!slug) return null
  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tenant
  const b = await prisma.business.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } })
  const tenant = b ? { id: b.id, name: b.name, slug: b.slug! } : null
  cache.set(slug, { tenant, at: Date.now() })
  return tenant
}

export const tenantOf = (c: Context) => tenantFromHeaders(c.req.raw.headers)

// A client that used to live at this address, for forwarding.
export async function movedTenantFromHeaders(headers: Headers): Promise<Tenant | null> {
  const slug = slugFromHost(hostOf(headers))
  if (!slug) return null
  const b = await prisma.business.findFirst({ where: { formerSlugs: { has: slug }, slug: { not: null } }, select: { id: true, name: true, slug: true } })
  return b ? { id: b.id, name: b.name, slug: b.slug! } : null
}

// Call after a slug or name changes so the next request sees it.
export function forgetTenant(slug?: string | null) {
  if (slug) cache.delete(slug)
  else cache.clear()
}

// True when the session's business may be used on this address.
export async function sessionAllowedHere(headers: Headers, businessId: string | null | undefined): Promise<boolean> {
  if (!tenantMode()) return true
  const tenant = await tenantFromHeaders(headers)
  return !!tenant && tenant.id === businessId
}

// Origins allowed to call the API with cookies. Entries may use one leading
// wildcard label: https://*.pos.flarehub.co.ke
const patterns = trustedOrigins.map(o => {
  if (!o.includes('*')) return { exact: o }
  const m = /^(https?):\/\/\*\.(.+)$/.exec(o)
  return m ? { scheme: m[1]!, suffix: '.' + m[2]! } : { exact: o }
})

export function isTrustedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  for (const p of patterns) {
    if ('exact' in p) {
      if (p.exact === origin) return true
      continue
    }
    let u: URL
    try {
      u = new URL(origin)
    } catch {
      return false
    }
    if (u.protocol !== p.scheme + ':' || u.port) continue
    const label = u.hostname.slice(0, -p.suffix.length)
    if (u.hostname.endsWith(p.suffix) && SLUG_RE.test(label)) return true
  }
  return false
}
