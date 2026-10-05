import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth.js'

export const adminRoutes = new Hono<AppEnv>()
