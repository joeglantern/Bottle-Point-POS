import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth.js'

export const reportRoutes = new Hono<AppEnv>()
