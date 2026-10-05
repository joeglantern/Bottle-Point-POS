import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth.js'

export const mpesaRoutes = new Hono<AppEnv>()
export const mpesaCallbackRoutes = new Hono()
