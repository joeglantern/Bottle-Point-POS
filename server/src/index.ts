import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { createApp } from './app.js'
import { env } from './env.js'
import { initRealtime } from './realtime.js'
import { prisma } from './db.js'
import { startMpesaSweeper } from './rules/mpesa.js'
import { startBillingScheduler } from './rules/billing.js'

const app = createApp()
const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`Bottle Point API on http://localhost:${info.port}`)
}) as Server

initRealtime(server)
const stopMpesaSweeper = startMpesaSweeper()
// hourly: trials ending, new periods, invoices, overdue and suspension
const stopBilling = startBillingScheduler()

const shutdown = async () => {
  stopMpesaSweeper()
  stopBilling()
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
