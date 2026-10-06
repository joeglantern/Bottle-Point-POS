// Touch and layout checks at phone, tablet, laptop and desktop sizes.
// Needs the API on :3000 and the web app on :5173. Run: node e2e/responsive.mjs
// Options: ONLY=360x740,768x1024 to limit viewports, THEMES=dark,light (default dark, light on two sizes).
import puppeteer from 'puppeteer-core'
import fs from 'fs'

const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p))
const URL = process.env.WEB_URL || 'http://localhost:5173'
const OUT = new globalThis.URL('./shots/responsive/', import.meta.url)
fs.mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: '360x740', width: 360, height: 740, touch: true, sale: true, light: true },
  { name: '390x844', width: 390, height: 844, touch: true },
  { name: '768x1024', width: 768, height: 1024, touch: true, sale: true, light: true },
  { name: '1024x768', width: 1024, height: 768, touch: true },
  { name: '1280x800', width: 1280, height: 800, touch: false },
  { name: '1920x1080', width: 1920, height: 1080, touch: false }
].filter(v => !process.env.ONLY || process.env.ONLY.split(',').includes(v.name))

// Targets allowed under 44px on touch, each with a reason.
const ALLOW = [
  ['.rc-shell *', 'receipt paper preview controls are sized to the paper, checked by eye'],
  ['input[type="checkbox"], input[type="radio"]', 'the wrapping label is the tap target'],
  ['.demo-note *', 'not interactive']
]

let failures = 0, checks = 0
const ok = m => { checks++ }
const fail = m => { failures++; console.log('  FAIL ' + m) }
const check = (c, m) => (c ? ok(m) : fail(m))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
let page, tag = ''
const problems = []

async function newPage(vp, theme) {
  page = await browser.newPage()
  await page.setViewport({ width: vp.width, height: vp.height, hasTouch: vp.touch, isMobile: vp.touch && vp.width < 1000, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(t => { try { localStorage.setItem('bp-theme', t) } catch {} }, theme)
  page.on('console', m => m.type() === 'error' && !/favicon|ERR_ABORTED|401/.test(m.text()) && problems.push(tag + ' console: ' + m.text().slice(0, 160)))
  page.on('pageerror', e => problems.push(tag + ' page error: ' + String(e).slice(0, 160)))
  page.on('requestfailed', r => !/ERR_ABORTED/.test(r.failure()?.errorText || '') && !/fonts\.g|\/events|\/stream/.test(r.url()) && problems.push(tag + ' request failed: ' + r.url()))
  page.on('response', r => r.status() >= 500 && problems.push(tag + ' ' + r.status() + ' ' + r.url()))
  await page.goto(URL, { waitUntil: 'networkidle2' })
}

// Tap (touch) or click the first visible element matching sel whose text includes text.
async function press(text, sel = 'button', vp = cur) {
  const h = await page.evaluateHandle((t, s) => [...document.querySelectorAll(s)].find(e => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && (!t || (e.innerText || e.getAttribute('aria-label') || '').toLowerCase().includes(t.toLowerCase()) || (e.getAttribute('aria-label') || '').toLowerCase() === t.toLowerCase())
  }), text, sel)
  const el = h.asElement()
  if (!el) return false
  await el.evaluate(e => e.scrollIntoView({ block: 'center' }))
  await sleep(80)
  if (vp.touch) await el.tap(); else await el.click()
  await sleep(350)
  return true
}
const hasText = t => page.evaluate(t => document.body.innerText.toLowerCase().includes(t.toLowerCase()), t)
const waitText = async (t, ms = 6000) => { for (let i = 0; i < ms / 150; i++) { if (await hasText(t)) return true; await sleep(150) } return false }

async function audit(screen, vp = cur) {
  tag = `[${vp.name} ${theme} ${role} ${screen}]`
  await sleep(250)
  const r = await page.evaluate((touch, allow) => {
    const vw = innerWidth, out = { overflow: document.documentElement.scrollWidth - vw, wide: [], small: [] }
    const seen = e => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < vw }
    const name = e => (e.tagName.toLowerCase() + '.' + String(e.className?.baseVal ?? e.className).replace(/\s+/g, '.') + ' "' + (e.innerText || e.getAttribute('aria-label') || '').slice(0, 24) + '"')
    const scrolls = e => { for (let p = e.parentElement; p; p = p.parentElement) { if (/auto|scroll/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth) return true } return false }
    for (const e of document.querySelectorAll('body *')) {
      const b = e.getBoundingClientRect()
      if (b.width > vw + 1 && seen(e) && !scrolls(e) && !e.closest('svg')) out.wide.push(name(e) + ' ' + Math.round(b.width))
    }
    if (touch) for (const e of document.querySelectorAll('button, a, input, select, textarea, [role=button]')) {
      if (!seen(e) || allow.some(a => e.matches(a))) continue
      const b = e.getBoundingClientRect()
      if (b.width < 43.5 || b.height < 43.5) out.small.push(name(e) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height))
    }
    return out
  }, vp.touch, ALLOW.map(a => a[0]))
  check(r.overflow <= 0, `${tag} horizontal overflow of ${r.overflow}px`)
  check(!r.wide.length, `${tag} wider than the viewport: ${r.wide.slice(0, 3).join(' | ')}`)
  check(!r.small.length, `${tag} targets under 44px: ${[...new Set(r.small)].slice(0, 5).join(' | ')}`)
  await page.screenshot({ path: new globalThis.URL(`${vp.name}-${theme === 'light' ? 'light-' : ''}${role}-${screen}.png`, OUT).pathname.replace(/^\/([A-Z]:)/, '$1').replace(/%20/g, ' ') })
}

const closeDialog = async () => { await page.keyboard.press('Escape'); await sleep(300) }
const compact = vp => vp.width < 900 || (vp.width <= 1100 && vp.height > vp.width)

async function go(label, vp = cur) {
  if (await press(label, '.rail nav button')) return true
  if (!(await press('More', '.rail nav button'))) return false
  return press(label, '.more-item')
}

const USERNAMES = { 'Wanjiru K.': 'wanjiru', 'Otieno J.': 'otieno', 'Achieng O.': 'achieng' }
async function signIn(name, vp = cur) {
  if (await page.$('.login-clear')) { await press('Not you?', '.login-clear'); await sleep(150) }
  const input = await page.$('.login-card input.label-in')
  await input.type(USERNAMES[name])
  for (const d of '1234') { await press(d, '.pad button'); await sleep(40) }
  await press('Sign in', '.pad button')
  await sleep(1400)
  if (await hasText('Opening float') || await hasText('Open your shift') || await page.$('.open-shift, .shift-open') ) {
    await audit('open-shift')
    if (!(await press('Open shift'))) await press('Not now')
    await sleep(800)
  }
  if (await hasText('Not now')) { await press('Not now'); await sleep(500) }
}
async function signOut(vp = cur) {
  if (compact(vp)) { await press('More', '.rail nav button'); await audit('more'); await press('Sign out', '.more-out') } else await press('Sign out', '.rail-out')
  await sleep(700)
}

async function sale(kind, vp = cur) {
  await go('Till')
  await press('Tusker Lager', '.product'); await press('Tusker Lager', '.product')
  if (compact(vp)) { await press('View order', '.till-bar button'); await audit('order-sheet') }
  await press('Pay now')
  if (kind === 'cash') {
    await audit('pay-cash')
    await press('Confirm receipt of payment')
  } else {
    await press('M-Pesa prompt')
    const phone = await page.$('.modal input')
    if (phone) { await phone.click({ clickCount: 3 }); await phone.type('0712345678') }
    await audit('pay-mpesa')
    await press('Send prompt')
    await audit('pay-stk-waiting')
  }
  const done = await waitText('Start next sale', 20000)
  check(done, `[${vp.name}] ${kind} sale completes by ${vp.touch ? 'touch' : 'mouse'}`)
  if (done) { await audit('receipt-' + kind); await press('Start next sale') } else await closeDialog()
  await sleep(400)
}

async function tour(vp = cur) {
  await audit('till')
  await press('Scan barcode', '.scan-btn'); await audit('scan'); await closeDialog()
  if (compact(vp)) {
    await press('Unpaid', '.till-bar-unpaid'); await audit('unpaid-sheet')
    await press('Order', '.sheet-tabs button')
    if (await press('Add customer', '.order button')) { await audit('customer-picker'); await closeDialog() }
    await press('Close', '.sheet-tabs button')
    check(await page.evaluate(() => !document.querySelector('.till-view.sheet-open')), tag + ' order sheet closes')
  }
  if (vp.sale) { await sale('cash'); await sale('mpesa') }
  if (await page.$('.shift-pill:not(.off)')) { await press('', '.shift-pill'); await audit('shift'); await closeDialog() }
  await go('Transactions'); await sleep(600)
  const row = await page.$('.rt-tx tbody tr')
  if (row) { if (vp.touch) await row.tap(); else await row.click(); await sleep(400) }
  await audit('transactions')
  await go('Customers'); await sleep(500); await audit('customers')
  if (role !== 'cashier') {
    await go('Inventory'); await sleep(700); await audit('inventory')
    await waitText('Receive delivery', 5000)
    check(await press('Receive delivery') && await waitText('Choose a product', 3000), tag + ' receive dialog opens'); await audit('inventory-receive'); await closeDialog()
    if (await press('Add product')) { await audit('inventory-product'); await closeDialog() }
    await go('Today'); await sleep(900); await audit('today')
    await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 1e5)); await audit('today-bottom')
    await go('Staff'); await sleep(600); await audit('staff')
    if (await press('Add staff')) { await audit('staff-add'); await closeDialog() }
  }
  if (role === 'owner') {
    await go('Branches'); await sleep(700); await audit('branches')
    await go('Settings'); await sleep(800); await audit('settings-business')
    for (const t of ['M-Pesa', 'Billing', 'Devices', 'Activity', 'Exports']) { await press(t, '.admin-tabs button'); await sleep(700); await audit('settings-' + t.toLowerCase().replace(/\W/g, '')) }
  }
}

let cur, theme, role
for (cur of VIEWPORTS) {
  const themes = (process.env.THEMES ? process.env.THEMES.split(',') : cur.light ? ['dark', 'light'] : ['dark'])
  for (theme of themes) {
    await newPage(cur, theme)
    role = 'login'; await audit('login')
    for (const [who, r] of [['Wanjiru K.', 'cashier'], ['Otieno J.', 'manager'], ['Achieng O.', 'owner']]) {
      role = r
      await signIn(who)
      const saleHere = cur.sale && theme === 'dark' && r === 'cashier'
      await tour({ ...cur, sale: saleHere })
      await signOut()
    }
    await page.close()
    console.log(`${cur.name} ${theme} done`)
  }
}
await browser.close()
for (const p of [...new Set(problems)]) fail(p)
console.log(failures ? `\n${failures} problem(s) in ${checks + failures} checks` : `\nResponsive walkthrough passed: ${checks} checks, no overflow, no small targets, no console errors`)
process.exit(failures ? 1 : 0)
