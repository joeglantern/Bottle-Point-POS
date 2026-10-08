// A shop's own brand: its name, its logo (if uploaded) and its colour.
// Public on purpose: the sign in screen shows it before anyone signs in.
import { prisma } from '../db.js'

export type BrandTheme = { buttons: string; highlights?: string | null; text?: string | null; glow?: string | null }
export type Branding = { name: string; accent: string | null; theme: BrandTheme | null; logoUrl: string | null }

export const logoUrlOf = (at: Date | null | undefined) => (at ? `/api/session/logo?v=${at.getTime()}` : null)

export async function brandingFor(businessId: string): Promise<Branding | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true, brandColor: true, brandTheme: true, logoUpdatedAt: true } })
  if (!b) return null
  const theme = (b.brandTheme as BrandTheme | null) ?? (b.brandColor ? { buttons: b.brandColor } : null)
  return { name: b.name, accent: theme?.buttons ?? null, theme, logoUrl: logoUrlOf(b.logoUpdatedAt) }
}
