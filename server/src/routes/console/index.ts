import { Hono } from 'hono'
import { requirePlatform, type ConsoleEnv } from '../../middleware/platform.js'
import { auditRoutes } from './audit.js'
import { billingRoutes } from './billing.js'
import { invoiceRoutes } from './invoices.js'
import { overviewRoutes } from './overview.js'
import { planRoutes } from './plans.js'
import { consoleSessionRoutes } from './session.js'
import { subscriptionRoutes } from './subscriptions.js'
import { teamRoutes } from './team.js'
import { tenantRoutes } from './tenants.js'

// The company console API, mounted at /api/console. Only platform staff.
export const consoleRoutes = new Hono<ConsoleEnv>()

consoleRoutes.route('/session', consoleSessionRoutes)

// Everything mounted on `secured` needs a console session.
export const secured = new Hono<ConsoleEnv>()
secured.use('*', requirePlatform)

// Each feature router declares its full paths from the console root, because
// several of them share the /tenants/:id prefix.
secured.route('/', overviewRoutes)
secured.route('/', tenantRoutes)
secured.route('/', subscriptionRoutes)
secured.route('/', planRoutes)
secured.route('/', invoiceRoutes)
secured.route('/', billingRoutes)
secured.route('/', teamRoutes)
secured.route('/', auditRoutes)

consoleRoutes.route('/', secured)
