// Scrolling and the side menu, on the built till, with no server: the files
// come straight from dist/ and the API answers with made up data.
//   npm run build && node e2e/layout-scroll.mjs
// Checks, on each screen size and page, with a banner showing: the page
// itself never scrolls, the menu never scrolls, and the content scrolls all
// the way to its end.

import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import puppeteer from 'puppeteer-core'

const ORIGIN = 'http://bp.test'
import { fileURLToPath } from 'node:url'
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' }

const branch = { id: 'b1', name: 'Westlands' }
const user = { id: 'u1', name: 'Achieng O.', username: 'achieng', role: 'OWNER', businessId: 'biz', branchIds: ['b1'], subscriptionStatus: null, trackStock: true, requireMpesaCode: true }
const products = Array.from({ length: 60 }, (_, i) => ({ id: 'p' + i, name: 'Product number ' + (i + 1), category: ['Whisky', 'Beer', 'Gin', 'Vodka'][i % 4], sizeMl: 750, barcode: null, priceCents: 100000 + i * 1000, active: true, qty: 20, reorderAt: 5 }))
const stock = products.map(p => ({ productId: p.id, name: p.name, category: p.category, barcode: null, priceCents: p.priceCents, qty: 20, reorderAt: 5, low: false }))
const API = {
  '/api/session/me': { user, branches: [branch], branding: { name: 'Nayotix', accent: null, logoUrl: null } },
  '/api/session/tenant': { tenant: { name: 'Nayotix', slug: 'nayotix' }, branding: { name: 'Nayotix', accent: null, logoUrl: null }, tenantMode: true },
  '/api/products': { branchId: 'b1', products },
  '/api/stock': { stock },
  '/api/shifts/current': { shift: { id: 's1', open: true, openingFloatCents: 0, expectedCashCents: 0, cashTakenCents: 0, mpesaTakenCents: 0, cashRefundsCents: 0, openedAt: new Date().toISOString() } },
  '/api/admin/business': { business: { id: 'biz', name: 'Nayotix', legalName: null, email: null, phone: null, address: null, kraPin: null, receiptFooter: null, vatRateBps: 1600, trackStock: true, requireMpesaCode: true, brandColor: null } },
  '/api/mpesa/status': { prompts: false, simulation: false }
}
const apiAnswer = path => {
  const p = path.split('?')[0]
  if (API[p]) return API[p]
  if (p === '/api/sales') return { sales: [] }
  if (p.startsWith('/api/admin/billing')) return { status: null, subscription: null, invoices: [], plans: [] }
  if (p.startsWith('/api/approvals')) return { approvals: [] }
  return {}
}

let failures = 0
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
const SIZES = [['phone', 390, 844, true], ['tablet portrait', 820, 1180, true], ['tablet landscape', 1180, 820, true], ['short laptop', 1366, 640, false], ['desktop', 1440, 900, false]]
const PAGES = [['till', null], ['settings', 'Settings'], ['inventory', 'Inventory']]

for (const [label, w, h, touch] of SIZES) {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch && w < 900 })
  await page.setRequestInterception(true)
  page.on('request', r => {
    const url = new URL(r.url())
    if (url.origin !== ORIGIN || url.pathname.startsWith('/socket.io')) return r.abort()
    if (url.pathname.startsWith('/api/')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(apiAnswer(url.pathname + url.search)) })
    const file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
    const f = existsSync(file) ? file : join(DIST, 'index.html')
    r.respond({ status: 200, contentType: TYPES[extname(f)] ?? 'application/octet-stream', body: readFileSync(f) })
  })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle0' })
  await sleep(600)
  // a banner showing, as right after a deploy
  await page.evaluate(() => window.dispatchEvent(new Event('bp:update-ready')))
  await sleep(300)
  for (const [name, nav] of PAGES) {
    if (nav) {
      const ok = await page.evaluate(n => {
        const b = [...document.querySelectorAll('.rail nav button')].find(x => x.getAttribute('aria-label') === n && x.offsetParent)
        if (b) { b.click(); return true }
        const more = document.querySelector('.nav-more'); if (!more || !more.offsetParent) return false
        more.click(); return 'more'
      }, nav)
      if (ok === 'more') { await sleep(300); await page.evaluate(n => [...document.querySelectorAll('.more-item')].find(b => b.textContent.includes(n))?.click(), nav) }
      await sleep(700)
    }
    const m = await page.evaluate(() => {
      const doc = document.scrollingElement
      const main = document.querySelector('main')
      const rail = document.querySelector('.rail')
      const before = main.scrollTop
      main.scrollTop = main.scrollHeight
      const after = main.scrollTop
      // the content's last part is now on screen
      const last = main.lastElementChild
      // on the till, the last product (the order panel slides in from off screen by design)
      const lastProduct = [...main.querySelectorAll('.catalog .product')].pop()
      const deepest = lastProduct ? lastProduct.getBoundingClientRect().bottom : [...main.querySelectorAll('*')].filter(e => getComputedStyle(e).position !== 'fixed').reduce((a, e) => Math.max(a, e.getBoundingClientRect().bottom), 0)
      const bar = document.querySelector('.till-bar')
      const mainRect = main.getBoundingClientRect()
      const floor = bar && bar.offsetParent ? Math.min(mainRect.bottom, bar.getBoundingClientRect().top) : mainRect.bottom
      const r = {
        pageScrolls: doc.scrollHeight > window.innerHeight + 1,
        railScrolls: rail.scrollHeight > rail.clientHeight + 1,
        railFits: rail.getBoundingClientRect().bottom <= window.innerHeight + 1,
        contentTaller: main.scrollHeight > main.clientHeight + 1,
        scrolled: after > before || main.scrollHeight <= main.clientHeight + 1,
        endVisible: deepest <= floor + 2,
        banner: !!document.querySelector('.billing-banner, .sync-banner')
      }
      main.scrollTop = 0
      return r
    })
    const tag = `${label} ${w}x${h}, ${name}`
    check(!m.pageScrolls, `${tag}: the page itself does not scroll`)
    check(!m.railScrolls && m.railFits, `${tag}: the menu fits and does not scroll`)
    check(m.scrolled && m.endVisible, `${tag}: the content scrolls to its end${m.contentTaller ? '' : ' (fits without scrolling)'}`)
  }
  for (const e of errors) check(false, `${label}: page error ${e}`)
  await page.close()
}
await browser.close()
console.log(failures ? `\n${failures} failed` : '\nLayout scroll checks passed')
process.exit(failures ? 1 : 0)
