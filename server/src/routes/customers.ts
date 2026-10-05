import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth.js'

export const customerRoutes = new Hono<AppEnv>()
