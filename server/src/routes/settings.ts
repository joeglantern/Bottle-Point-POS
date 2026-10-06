import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth.js'
import { auditRoutes } from './settings/audit.js'
import { billingRoutes } from './settings/billing.js'
import { businessRoutes } from './settings/business.js'
import { exportsRoutes } from './settings/exports.js'
import { mpesaRoutes } from './settings/mpesa.js'
import { sessionsRoutes } from './settings/sessions.js'

// Owner settings for a business, mounted at /api/admin next to adminRoutes:
// business details, M-Pesa setup, activity log, devices, exports, billing.
// Each area lives in its own file under ./settings and registers paths
// relative to /api/admin.
export const settingsRoutes = new Hono<AppEnv>()

settingsRoutes.route('/', businessRoutes)
settingsRoutes.route('/', mpesaRoutes)
settingsRoutes.route('/', auditRoutes)
settingsRoutes.route('/', sessionsRoutes)
settingsRoutes.route('/', exportsRoutes)
settingsRoutes.route('/', billingRoutes)
