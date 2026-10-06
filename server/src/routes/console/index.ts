import { Hono } from 'hono'
import { requirePlatform, type ConsoleEnv } from '../../middleware/platform.js'
import { consoleSessionRoutes } from './session.js'

// The company console API, mounted at /api/console. Only platform staff.
export const consoleRoutes = new Hono<ConsoleEnv>()

consoleRoutes.route('/session', consoleSessionRoutes)

// Everything mounted on `secured` needs a console session.
export const secured = new Hono<ConsoleEnv>()
secured.use('*', requirePlatform)

// Feature routers are mounted on `secured` here, for example:
//   secured.route('/tenants', tenantRoutes)

consoleRoutes.route('/', secured)
