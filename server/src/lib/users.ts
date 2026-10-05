import { hashPassword } from 'better-auth/crypto'
import { randomUUID } from 'node:crypto'
import type { Db, Role } from '../db.js'

// Creates a staff member with a username and PIN, in the shape Better Auth
// expects (a user row plus a "credential" account holding the hash).
export async function createStaff(
  db: Db,
  input: { businessId: string; name: string; username: string; pin: string; role: Role; branchIds: string[] }
) {
  const id = randomUUID()
  const username = input.username.trim().toLowerCase()
  const user = await db.user.create({
    data: {
      id,
      name: input.name,
      username,
      displayUsername: input.username.trim(),
      // Better Auth requires an email. Staff sign in by username only.
      email: `${username}@staff.bottlepoint.local`,
      emailVerified: true,
      role: input.role,
      businessId: input.businessId,
      branches: { create: input.branchIds.map(branchId => ({ branchId })) }
    }
  })
  await db.account.create({
    data: {
      id: randomUUID(),
      accountId: id,
      providerId: 'credential',
      userId: id,
      password: await hashPassword(input.pin)
    }
  })
  return user
}

export async function setPin(db: Db, userId: string, pin: string) {
  await db.account.updateMany({
    where: { userId, providerId: 'credential' },
    data: { password: await hashPassword(pin) }
  })
}

export const pinSchemaRule = /^\d{4,6}$/
