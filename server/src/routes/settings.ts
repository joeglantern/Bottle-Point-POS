import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth.js'

// Owner settings for a business, mounted at /api/admin next to adminRoutes:
// business details, M-Pesa setup, activity log, devices, exports, billing.
export const settingsRoutes = new Hono<AppEnv>()
