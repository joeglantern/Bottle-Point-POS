// A shop's own brand: its name, its logo (if uploaded) and its colour.
// Public on purpose: the sign in screen shows it before anyone signs in.
import { prisma } from '../db.js'

export type Branding = { name: string; accent: string | null; logoUrl: string | null }

export const logoUrlOf = (at: Date | null | undefined) => (at ? `/api/session/logo?v=${at.getTime()}` : null)

export async function brandingFor(businessId: string): Promise<Branding | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true, brandColor: true, logoUpdatedAt: true } })
  return b ? { name: b.name, accent: b.brandColor, logoUrl: logoUrlOf(b.logoUpdatedAt) } : null
}
