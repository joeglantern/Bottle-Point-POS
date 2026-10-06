import { hashPassword } from 'better-auth/crypto'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db, PlatformRole, Role } from '../db.js'

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

// Console passwords: long enough to resist guessing, not a single repeated character.
export const passwordRule = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128)
  .refine(p => new Set(p).size >= 5, 'That password is too simple')

// Creates someone on the platform team (console access, no business).
export async function createPlatformUser(db: Db, input: { name: string; email: string; password: string; role: PlatformRole }) {
  const id = randomUUID()
  const user = await db.user.create({
    data: {
      id,
      name: input.name,
      email: input.email.trim().toLowerCase(),
      emailVerified: true,
      platformRole: input.role
    }
  })
  await db.account.create({
    data: { id: randomUUID(), accountId: id, providerId: 'credential', userId: id, password: await hashPassword(input.password) }
  })
  return user
}

export async function setPassword(db: Db, userId: string, password: string) {
  await db.account.updateMany({ where: { userId, providerId: 'credential' }, data: { password: await hashPassword(password) } })
}
