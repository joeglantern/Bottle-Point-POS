import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { username } from 'better-auth/plugins'
import { prisma } from './db.js'
import { env, secureCookies, trustedOrigins } from './env.js'
import { isTrustedOrigin } from './lib/tenant.js'

// Staff sign in with username and PIN. Accounts are only ever created by an
// owner (or the seed), never through a public sign up route.
export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  // the fixed list, plus the calling origin when it matches a wildcard entry
  // such as https://*.pos.flarehub.co.ke
  trustedOrigins: request => {
    const origin = request?.headers.get('origin')
    return origin && isTrustedOrigin(origin) ? [...trustedOrigins.filter(o => !o.includes('*')), origin] : trustedOrigins.filter(o => !o.includes('*'))
  },
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 4,
    maxPasswordLength: 128
  },
  plugins: [username({ minUsernameLength: 3, maxUsernameLength: 32 })],
  user: {
    additionalFields: {
      role: { type: 'string', input: false },
      businessId: { type: 'string', input: false, required: false },
      active: { type: 'boolean', input: false }
    }
  },
  session: {
    expiresIn: 60 * 60 * 12, // a working day
    updateAge: 60 * 15
  },
  rateLimit: {
    enabled: env.NODE_ENV !== 'test',
    storage: 'memory',
    window: 60,
    max: 120
  },
  advanced: {
    useSecureCookies: secureCookies,
    defaultCookieAttributes: { sameSite: 'strict', httpOnly: true, secure: secureCookies }
  },
  telemetry: { enabled: false }
})
