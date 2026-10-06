import type { Db } from '../db.js'
import type { Actor } from '../middleware/auth.js'

export async function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  entity: string,
  entityId: string | null,
  data?: Record<string, unknown>,
  branchId?: string | null
) {
  await db.auditLog.create({
    data: {
      userId: actor?.id ?? null,
      businessId: actor?.businessId ?? null,
      branchId: branchId ?? null,
      action,
      entity,
      entityId,
      data: (data ?? undefined) as never
    }
  })
}

// Something a console user (or the platform itself, when `platform` is null)
// did. `businessId` is the client it was done to, if any, so it also shows up
// when looking at that client's history. Actions start with "console." or
// "billing." by convention.
export async function platformAudit(
  db: Db,
  platform: { id: string } | null,
  action: string,
  entity: string,
  entityId: string | null,
  data?: Record<string, unknown>,
  businessId?: string | null
) {
  await db.auditLog.create({
    data: {
      userId: platform?.id ?? null,
      businessId: businessId ?? null,
      branchId: null,
      action,
      entity,
      entityId,
      data: (data ?? undefined) as never
    }
  })
}
