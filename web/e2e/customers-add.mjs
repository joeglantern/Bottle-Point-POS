// Adding a customer, both ways (Customers page, and from a sale), on the built
// till with made up API answers: the customer must reach the server. With no
// internet it must say so plainly, never look saved when it is not.
//   npm run build && node e2e/customers-add.mjs

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ORIGIN = 'http://bp.test'
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const user = { id: 'u1', name: 'Naomi', username: 'naomi', role: 'OWNER', businessId: 'biz', branchIds: ['b1'], trackStock: false, requireMpesaCode: false }
const customers = []
const posts = []
let down = false

function answer(method, path, body) {
  const p = path.split('?')[0]
  if (p === '/api/session/me') return [200, { user, branches: [{ id: 'b1', name: 'Main' }], branding: { name: 'Nayotix', theme: null, logoUrl: null } }]
  if (p === '/api/customers' && method === 'POST') {
    const c = { id: 'c' + (customers.length + 1), ...JSON.parse(body), createdAt: new Date().toISOString(), visits: 0, spentCents: 0 }
    customers.push(c)
    posts.push(c)
    return [201, { customer: c }]
  }
  if (p === '/api/customers') return [200, { customers }]
  if (p.startsWith('/api/customers/')) return [200, { customer: customers[0], sales: [] }]
  if (p === '/api/products') return [200, { products: [{ id: 'p1', name: 'Tusker', category: 'Beer', priceCents: 30000, qty: null }] }]
  if (p === '/api/sales') return [200, { sales: [] }]
  if (p === '/api/shifts/current') return [200, { shift: { id: 's', open: true, expectedCashCents: 0 } }]
  return [200, {}]
}

let failures = 0
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.setRequestInterception(true)
page.on('request', r => {
  const url = new URL(r.url())
  if (url.origin !== ORIGIN || url.pathname.startsWith('/socket.io')) return r.abort()
  if (url.pathname.startsWith('/api/')) {
    if (down) return r.abort('internetdisconnected')
    const [status, body] = answer(r.method(), url.pathname + url.search, r.postData())
    return r.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
  }
  const file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
  const f = existsSync(file) ? file : join(DIST, 'index.html')
  r.respond({ status: 200, contentType: TYPES[extname(f)] ?? 'application/octet-stream', body: readFileSync(f) })
})
const errors = []
page.on('pageerror', e => errors.push(e.message))
const text = () => page.evaluate(() => document.body.innerText)
const click = label => page.evaluate(l => { const b = [...document.querySelectorAll('button')].filter(x => !x.disabled).find(x => x.textContent.trim() === l || x.getAttribute('aria-label') === l); if (b) b.click(); return !!b }, label)

await page.goto(ORIGIN + '/', { waitUntil: 'networkidle0' })
await sleep(600)

console.log('\nFrom the Customers page')
await page.click('.rail button[aria-label="Customers"]')
await sleep(700)
check(await click('New customer'), 'New customer opens a form')
await sleep(300)
await page.type('.modal input.label-in', 'Mama Wanjiku')
await page.type('.modal input[inputmode="tel"]', '0712345678')
await click('Save')
await sleep(800)
check(posts.length === 1 && posts[0].name === 'Mama Wanjiku', 'the customer reached the server: ' + JSON.stringify(posts[0] ?? null))
check((await text()).includes('Mama Wanjiku'), 'and shows in the list')

console.log('\nFrom a sale')
await page.click('.rail button[aria-label="Till"]')
await sleep(800)
await page.evaluate(() => [...document.querySelectorAll('.product')].find(p => p.textContent.includes('Tusker'))?.click())
await sleep(300)
check(await click('+ Add customer'), 'Add customer opens on the sale')
await sleep(500)
await click('New customer')
await sleep(300)
await page.type('.modal input.label-in', 'Baba Otieno')
await click('Add and attach')
await sleep(800)
check(posts.length === 2 && posts[1].name === 'Baba Otieno', 'the customer reached the server: ' + JSON.stringify(posts[1] ?? null))

console.log('\nWith no internet')
down = true
await page.click('.rail button[aria-label="Customers"]')
await sleep(1200)
await click('New customer')
await sleep(300)
await page.type('.modal input.label-in', 'Offline Person')
await click('Save')
await sleep(9500)
const t = await text()
check(posts.length === 2, 'nothing was saved')
check(/needs the internet|cannot reach/i.test(t), 'and the till says it needs the internet')
check(!/Customer added/.test(t), 'it never says "Customer added"')
for (const e of errors) check(false, 'page error: ' + e)
await browser.close()
console.log(failures ? `\n${failures} failed` : '\nCustomer checks passed')
process.exit(failures ? 1 : 0)
