// Creates a console user from the command line. This is how the first super
// admin of an installation comes to exist.
//
//   npm run platform:admin -- <email> "<Full Name>" [SUPER_ADMIN|SUPPORT|BILLING]
//   npm run platform:admin -- <email> --reset-password
//
// The password is generated here and printed once. It is stored only as a hash.
import { z } from 'zod'
import { prisma } from '../src/db.js'
import { platformAudit } from '../src/lib/audit.js'
import { createPlatformUser, setPassword } from '../src/lib/users.js'
import { temporaryPassword } from '../src/rules/platform.js'

const ROLES = ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const
const USAGE = 'Usage: npm run platform:admin -- <email> "<Full Name>" [SUPER_ADMIN|SUPPORT|BILLING] [--reset-password]'

export type AdminResult = { code: number; out: string[]; err: string[] }

// Does the work and returns what to print, so tests can call it directly.
export async function createPlatformAdmin(argv: string[]): Promise<AdminResult> {
  const out: string[] = []
  const fail = (...err: string[]): AdminResult => ({ code: 1, out, err })

  const resetPassword = argv.includes('--reset-password')
  const unknown = argv.filter(a => a.startsWith('--') && a !== '--reset-password')
  if (unknown.length) return fail(`Unknown option ${unknown[0]}.`, USAGE)
  const [emailArg, nameArg, roleArg] = argv.filter(a => !a.startsWith('--'))

  const email = z.string().trim().toLowerCase().email().max(200).safeParse(emailArg)
  if (!email.success) return fail('Give a valid email address.', USAGE)
  const role = z.enum(ROLES).safeParse((roleArg ?? 'SUPER_ADMIN').toUpperCase())
  if (!role.success) return fail(`Role must be one of ${ROLES.join(', ')}.`, USAGE)

  const existing = await prisma.user.findUnique({ where: { email: email.data } })
  if (existing) {
    if (!existing.platformRole || existing.businessId) return fail(`${email.data} belongs to shop staff and cannot be a console user.`)
    if (!resetPassword) {
      return fail(`${email.data} is already a console user. Pass --reset-password to give them a new password.`)
    }
    const password = temporaryPassword(20)
    await prisma.$transaction(async tx => {
      await setPassword(tx, existing.id, password)
      await tx.user.update({ where: { id: existing.id }, data: { failedPins: 0, lockedUntil: null } })
      const ended = await tx.session.deleteMany({ where: { userId: existing.id } })
      await platformAudit(tx, null, 'console.team.password_reset', 'user', existing.id, {
        name: existing.name,
        email: existing.email,
        sessionsEnded: ended.count,
        via: 'command line'
      })
    })
    out.push(`Password reset for ${existing.name} <${existing.email}>.`, `New password: ${password}`, 'It is shown once. Change it after signing in.')
    return { code: 0, out, err: [] }
  }

  const name = z.string().trim().min(2).max(80).safeParse(nameArg)
  if (!name.success) return fail('Give the full name in quotes.', USAGE)
  if (email.data.endsWith('@staff.bottlepoint.local')) return fail('That address is reserved for shop staff.')

  const password = temporaryPassword(20)
  const user = await prisma.$transaction(async tx => {
    const created = await createPlatformUser(tx, { name: name.data, email: email.data, password, role: role.data })
    await platformAudit(tx, null, 'console.team.created', 'user', created.id, {
      name: created.name,
      email: created.email,
      role: role.data,
      via: 'command line'
    })
    return created
  })
  out.push(`Created ${role.data} ${user.name} <${user.email}>.`, `Password: ${password}`, 'It is shown once. Change it after signing in.')
  return { code: 0, out, err: [] }
}

const invokedDirectly = /[\\/]scripts[\\/]create-platform-admin\.(ts|js)$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  createPlatformAdmin(process.argv.slice(2))
    .then(async result => {
      for (const line of result.out) console.log(line)
      for (const line of result.err) console.error(line)
      await prisma.$disconnect()
      process.exit(result.code)
    })
    .catch(async err => {
      console.error(err instanceof Error ? err.message : err)
      await prisma.$disconnect()
      process.exit(1)
    })
}
