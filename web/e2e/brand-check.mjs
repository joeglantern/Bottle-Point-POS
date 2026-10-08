// The shop's brand on the built till, with no server (made up API answers):
// the sign in screen with and without a logo, the colour panel, previews that
// go away unsaved, saving the set, and nothing left behind after signing out.
//   npm run build && node e2e/brand-check.mjs

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ORIGIN = 'http://bp.test'
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const LOGO = readFileSync(fileURLToPath(new URL('../public/brand/icon-512.png', import.meta.url)))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const SHOTS = 'e2e/shots'

let signedIn = false
let withLogo = true
let theme = { buttons: '#0a7c5a', highlights: '#f2a900' }
let patched = null
const branding = () => ({ name: 'Nayotix', accent: theme?.buttons ?? null, theme, logoUrl: withLogo ? '/api/session/logo?v=1' : null })
const user = { id: 'u1', name: 'Achieng O.', username: 'achieng', role: 'OWNER', businessId: 'biz', branchIds: ['b1'], trackStock: true, requireMpesaCode: true }
function answer(method, path, body) {
  const p = path.split('?')[0]
  if (p === '/api/session/tenant') return [200, { tenant: { name: 'Nayotix', slug: 'nayotix' }, branding: branding(), tenantMode: true }]
  if (p === '/api/session/me') return signedIn ? [200, { user, branches: [{ id: 'b1', name: 'Westlands' }], branding: branding() }] : [401, { error: { code: 'unauthorized', message: 'Sign in first.' } }]
  if (p === '/api/session/logout') { signedIn = false; return [200, { ok: true }] }
  if (p === '/api/admin/business' && method === 'PATCH') { patched = JSON.parse(body); theme = patched.brandTheme; return [200, { business: { brandTheme: theme } }] }
  if (p === '/api/admin/business') return [200, { business: { id: 'biz', name: 'Nayotix', vatRateBps: 1600, trackStock: true, requireMpesaCode: true, brandColor: theme?.buttons ?? null, brandTheme: theme } }]
  if (p === '/api/products') return [200, { products: [{ id: 'p1', name: 'Tusker', category: 'Beer', priceCents: 30000, qty: 9 }] }]
  if (p === '/api/sales') return [200, { sales: [] }]
  if (p === '/api/shifts/current') return [200, { shift: { id: 's', open: true, expectedCashCents: 0 } }]
  return [200, {}]
}

let failures = 0
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })

async function open(w, h, mode = 'dark') {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h })
  await page.evaluateOnNewDocument(t => { try { localStorage.setItem('bp-theme', t) } catch {} }, mode)
  await page.setRequestInterception(true)
  page.on('request', r => {
    const url = new URL(r.url())
    if (url.origin !== ORIGIN || url.pathname.startsWith('/socket.io')) return r.abort()
    if (url.pathname === '/api/session/logo') return r.respond({ status: 200, contentType: 'image/png', body: LOGO })
    if (url.pathname.startsWith('/api/')) {
      const [status, body] = answer(r.method(), url.pathname + url.search, r.postData())
      return r.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
    }
    const file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
    const f = existsSync(file) ? file : join(DIST, 'index.html')
    r.respond({ status: 200, contentType: TYPES[extname(f)] ?? 'application/octet-stream', body: readFileSync(f) })
  })
  page.errors = []
  page.on('pageerror', e => page.errors.push(e.message))
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle0' })
  await sleep(500)
  return page
}
const cssVar = (page, name) => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)

console.log('\nSign in screen')
for (const [w, h, mode, logo] of [[1440, 900, 'dark', true], [1440, 900, 'light', true], [1440, 900, 'dark', false], [390, 844, 'dark', true]]) {
  withLogo = logo
  const page = await open(w, h, mode)
  const m = await page.evaluate(() => {
    const name = document.querySelector('.login-shop-name')
    const bp = document.querySelector('.login-by .logo img:not([style*="none"])')
    const bpImgs = [...document.querySelectorAll('.login-by .logo img')].filter(i => getComputedStyle(i).display !== 'none')
    const shopLogo = document.querySelector('.login-shop-logo')
    return {
      name: name?.textContent, nameSize: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
      underline: name ? getComputedStyle(name, '::after').content : 'none',
      bpWidth: bpImgs[0]?.getBoundingClientRect().width ?? 0,
      shopLogo: !!shopLogo && shopLogo.naturalWidth > 0
    }
  })
  const tag = `${w}x${h} ${mode}${logo ? ', logo' : ', no logo'}`
  check(m.name === 'Nayotix', `${tag}: shop name shown`)
  check(m.underline === 'none' || m.underline === 'normal', `${tag}: no underline under the name`)
  check(logo ? m.shopLogo : !m.shopLogo, `${tag}: the shop logo ${logo ? 'shows' : 'is absent'}`)
  if (w > 900) check(m.bpWidth >= 400 && m.nameSize < 60, `${tag}: Bottle Point at full size (${Math.round(m.bpWidth)}px), name smaller (${m.nameSize}px)`)
  else check(m.bpWidth >= 200, `${tag}: Bottle Point large on a phone (${Math.round(m.bpWidth)}px)`)
  check((await cssVar(page, '--gold')) === '#0a7c5a', `${tag}: the shop's button colour applies`)
  await page.screenshot({ path: `${SHOTS}/brand-login-${w}-${mode}${logo ? '' : '-nologo'}.png` })
  for (const e of page.errors) check(false, `${tag}: page error ${e}`)
  await page.close()
}

console.log('\nColour panel')
withLogo = true
signedIn = true
{
  const page = await open(1440, 900)
  await page.click('.rail button[aria-label="Settings"]')
  await sleep(900)
  const parts = await page.$$eval('.part-label b', bs => bs.map(b => b.textContent))
  check(parts.join(',') === 'Buttons,Highlights,Text accents,Background glow', 'four parts to colour: ' + parts.join(', '))
  check((await page.$$('.logo-colours span')).length > 0, 'colours read from the logo')
  check((await cssVar(page, '--hl')) === '#f2a900', 'saved highlight colour applies')
  // preview: highlights in the second logo colour
  await page.evaluate(() => [...document.querySelectorAll('.part')][1].querySelectorAll('.swatch')[2].click())
  await sleep(200)
  const preview = await cssVar(page, '--hl')
  check(preview !== '#f2a900', `picking previews at once (${preview})`)
  await page.screenshot({ path: `${SHOTS}/brand-panel.png`, fullPage: false })
  // leave without saving: the saved colours come back
  await page.click('.rail button[aria-label="Till"]')
  await sleep(600)
  check((await cssVar(page, '--hl')) === '#f2a900', 'leaving without saving puts the saved colours back')
  // pick again and save
  await page.click('.rail button[aria-label="Settings"]')
  await sleep(800)
  await page.evaluate(() => [...document.querySelectorAll('.part')][3].querySelectorAll('.swatch')[1].click())
  await sleep(200)
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save colours').click())
  await sleep(800)
  check(!!patched?.brandTheme?.buttons && !!patched.brandTheme.glow, 'Save colours sends the whole set: ' + JSON.stringify(patched?.brandTheme))
  // sign out on a browser with no shop address: nothing of the shop stays
  theme = null
  await page.click('.rail-out')
  await sleep(900)
  check(!(await page.$('#bp-brand')), 'signing out leaves no shop colours behind')
  for (const e of page.errors) check(false, `panel: page error ${e}`)
  await page.close()
}

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nBrand checks passed')
process.exit(failures ? 1 : 0)
