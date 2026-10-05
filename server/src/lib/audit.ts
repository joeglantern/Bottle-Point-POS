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
