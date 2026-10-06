// Runs the billing engine once and prints what it did.
//   npm run billing:run
import { prisma } from '../src/db.js'
import { runBilling } from '../src/rules/billing.js'

try {
  const summary = await runBilling()
  console.log(JSON.stringify(summary, null, 2))
  if (summary.errors.length) process.exitCode = 1
} catch (e) {
  console.error('Billing run failed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
