import { Hono } from 'hono'
import { prisma } from '../../db.js'
import { platformAudit } from '../../lib/audit.js'
import { allowPlatform, type ConsoleEnv } from '../../middleware/platform.js'
import { previewBilling, runBilling } from '../../rules/billing.js'

export const billingRoutes = new Hono<ConsoleEnv>()

// What a run would do right now. Changes nothing, so any console role may look.
billingRoutes.get('/billing/preview', async c => {
  return c.json({ preview: await previewBilling() })
})

// Run the billing engine now. Safe next to the hourly schedule: every client
// is locked while it is billed, so nothing is invoiced twice.
billingRoutes.post('/billing/run', allowPlatform('BILLING'), async c => {
  const summary = await runBilling()
  // each change wrote its own audit row with the client; this records who pressed the button
  await platformAudit(prisma, c.get('platform'), 'console.billing.run', 'Billing', null, {
    invoicesCreated: summary.invoicesCreated,
    trialsConverted: summary.trialsConverted,
    markedPastDue: summary.markedPastDue,
    suspended: summary.suspended,
    cancelled: summary.cancelled,
    errors: summary.errors.length
  })
  return c.json({ summary })
})
