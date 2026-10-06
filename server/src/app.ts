import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { bodyLimit } from 'hono/body-limit'
import { auth } from './auth.js'
import { prisma, Prisma } from './db.js'
import { trustedOrigins } from './env.js'
import { AppError } from './lib/errors.js'
import { requireActiveSubscription, requireAuth, type AppEnv } from './middleware/auth.js'
import { sessionRoutes } from './routes/session.js'
import { salesRoutes } from './routes/sales.js'
import { mpesaRoutes, mpesaCallbackRoutes } from './routes/mpesa.js'
import { shiftRoutes } from './routes/shifts.js'
import { approvalRoutes } from './routes/approvals.js'
import { reportRoutes } from './routes/reports.js'
import { productRoutes } from './routes/products.js'
import { stockRoutes } from './routes/stock.js'
import { customerRoutes } from './routes/customers.js'
import { adminRoutes } from './routes/admin.js'
import { settingsRoutes } from './routes/settings.js'
import { consoleRoutes } from './routes/console/index.js'

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use('*', secureHeaders())
  app.use('/api/*', cors({ origin: trustedOrigins, credentials: true }))
  app.use('/api/*', bodyLimit({ maxSize: 100 * 1024 }))

  // Cookie auth plus SameSite=Strict already blocks most CSRF. This also
  // rejects any state changing request from an origin we do not trust.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      const origin = c.req.header('origin')
      if (origin && !trustedOrigins.includes(origin) && !c.req.path.startsWith('/api/mpesa/callback')) {
        return c.json({ error: { code: 'bad_origin', message: 'Origin not allowed.' } }, 403)
      }
    }
    await next()
  })

  app.get('/api/health', async c => {
    await prisma.$queryRaw`SELECT 1`
    return c.json({ ok: true })
  })

  // Only the Better Auth endpoints we actually use are reachable. Sign up and
  // everything else stays closed. Sign in goes through /api/session/pin.
  app.on(['GET'], '/api/auth/get-session', c => auth.handler(c.req.raw))
  app.on(['POST'], '/api/auth/sign-out', c => auth.handler(c.req.raw))
  app.all('/api/auth/*', c => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404))

  app.route('/api/session', sessionRoutes)

  // Safaricom calls this, so it has no session. It is protected by a secret
  // token in the URL and by matching the request we sent.
  app.route('/api/mpesa/callback', mpesaCallbackRoutes)

  // The company console: platform staff only, separate sign in.
  app.route('/api/console', consoleRoutes)

  const api = new Hono<AppEnv>()
  api.use('*', requireAuth, requireActiveSubscription)
  api.route('/sales', salesRoutes)
  api.route('/mpesa', mpesaRoutes)
  api.route('/shifts', shiftRoutes)
  api.route('/approvals', approvalRoutes)
  api.route('/reports', reportRoutes)
  api.route('/products', productRoutes)
  api.route('/stock', stockRoutes)
  api.route('/customers', customerRoutes)
  api.route('/admin', adminRoutes)
  api.route('/admin', settingsRoutes)
  app.route('/api', api)

  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404))

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status)
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // two tills racing to use the same M-Pesa code: the unique index wins
      if (err.code === 'P2002' && JSON.stringify(err.meta ?? {}).includes('mpesaRef')) {
        return c.json({ error: { code: 'mpesa_code_used', message: 'This M-Pesa code is already linked to another sale.' } }, 409)
      }
      if (err.code === 'P2002') return c.json({ error: { code: 'duplicate', message: 'That already exists.', details: err.meta } }, 409)
      if (err.code === 'P2025') return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
    }
    console.error(err)
    return c.json({ error: { code: 'server_error', message: 'Something went wrong.' } }, 500)
  })

  return app
}
