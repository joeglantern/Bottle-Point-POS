// Loads a shop's product list (name, category, size, price) from JSON on stdin.
//
//   docker compose exec -T api npx tsx scripts/import-products.ts --shop <address> [--dry-run] < products.json
//
// products.json: [{ "name": "Tusker Bottle", "category": "Beer", "sizeMl": 500, "priceCents": 30000, "barcode": null }]
//
// A product with the same name and size as one the shop already has is left
// alone, so running it twice adds nothing. New products start with no stock in
// every branch; the shop records its first delivery in Inventory.
import { z } from 'zod'
import { prisma } from '../src/db.js'
import { ensureStockRows } from '../src/rules/catalog.js'

const item = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40),
  sizeMl: z.number().int().min(1).max(100_000).nullable().optional(),
  priceCents: z.number().int().min(1).max(1_000_000_000),
  barcode: z.string().trim().regex(/^\d{6,14}$/).nullable().optional()
})

async function readStdin() {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const args = process.argv.slice(2)
  const shop = args[args.indexOf('--shop') + 1]
  const dry = args.includes('--dry-run')
  if (!args.includes('--shop') || !shop) throw new Error('Usage: import-products.ts --shop <address> [--dry-run] < products.json')

  const list = z.array(item).min(1).max(5000).parse(JSON.parse(await readStdin()))
  const business = await prisma.business.findUnique({ where: { slug: shop } })
  if (!business) throw new Error(`No shop at the address "${shop}".`)

  const existing = await prisma.product.findMany({ where: { businessId: business.id }, select: { name: true, sizeMl: true } })
  const key = (name: string, size: number | null | undefined) => `${name.trim().toLowerCase()}|${size ?? ''}`
  const have = new Set(existing.map(p => key(p.name, p.sizeMl)))
  const fresh = list.filter((p, i) => !have.has(key(p.name, p.sizeMl)) && list.findIndex(q => key(q.name, q.sizeMl) === key(p.name, p.sizeMl)) === i)

  console.log(`${business.name}: ${list.length} in the file, ${existing.length} already in the shop, ${fresh.length} to add.`)
  if (dry || !fresh.length) {
    if (dry) console.log('Dry run: nothing written.')
    return
  }

  const added = await prisma.$transaction(async tx => {
    const branches = await tx.branch.findMany({ where: { businessId: business.id, active: true }, select: { id: true } })
    const ids: string[] = []
    for (const p of fresh) {
      const row = await tx.product.create({
        data: { businessId: business.id, name: p.name, category: p.category, sizeMl: p.sizeMl ?? null, priceCents: p.priceCents, barcode: p.barcode ?? null }
      })
      ids.push(row.id)
    }
    await ensureStockRows(tx, branches.map(b => b.id), ids)
    await tx.auditLog.create({
      data: { businessId: business.id, action: 'product.imported', entity: 'business', entityId: business.id, data: { count: ids.length, source: 'price list' } }
    })
    return ids.length
  }, { timeout: 60_000 })
  console.log(`Added ${added} products, each with no stock yet.`)
}

main()
  .catch(err => {
    console.error(err instanceof z.ZodError ? 'The file is not a valid product list: ' + err.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('; ') : err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
