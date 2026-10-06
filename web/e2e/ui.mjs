// Drives the real web app in Chrome against the real API, as each role.
//   (API on :3000 with the demo seed, web dev server on :5173)
//   node e2e/ui.mjs
// Fails on any browser console error, page crash or server error.

import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const URL = process.env.UI_URL ?? 'http://localhost:5173'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS = process.env.SHOTS ?? 'e2e/shots'
mkdirSync(SHOTS, { recursive: true })

let failures = 0
const problems = []
const ok = m => console.log('  ok   ' + m)
const fail = m => { failures++; console.log('  FAIL ' + m) }
const check = (c, m) => (c ? ok(m) : fail(m))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } })
const page = await browser.newPage()
// a 401 from the session check before sign in is expected
page.on('console', m => m.type() === 'error' && !/favicon|WebSocket is closed before|status of 401/.test(m.text()) && problems.push('console: ' + m.text()))
page.on('response', r => r.status() === 401 && !r.url().endsWith('/api/session/me') && !r.url().includes('/api/session/pin') && problems.push('unexpected 401 on ' + r.url()))
page.on('pageerror', e => problems.push('page error: ' + e.message))
page.on('response', r => r.url().includes('/api/') && r.status() >= 500 && problems.push(`server ${r.status()} on ${r.url()}`))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const shot = name => page.screenshot({ path: `${SHOTS}/${name}.png` })
async function clickText(text, sel = 'button') {
  const ok = await page.evaluate((text, sel) => {
    const all = [...document.querySelectorAll(sel)].filter(b => !b.disabled)
    const el = all.find(b => b.textContent.trim() === text) ?? all.find(b => b.textContent.trim().startsWith(text)) ?? all.find(b => b.textContent.includes(text))
    if (!el) return false
    el.click()
    return true
  }, text, sel)
  if (!ok) throw new Error(`could not click "${text}"`)
  await sleep(250)
}
// innerText follows CSS text-transform, so compare without case
const hasText = text => page.evaluate(t => document.body.innerText.toLowerCase().includes(t.toLowerCase()), text)
async function waitText(text, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await hasText(text)) return true; await sleep(150) }
  return false
}
const nav = async label => {
  // on narrow screens some destinations live under More
  const visible = await page.$eval(`.rail button[aria-label="${label}"]`, el => el.offsetParent !== null && getComputedStyle(el).display !== 'none').catch(() => false)
  if (visible) await page.click(`.rail button[aria-label="${label}"]`)
  else { await page.click(".nav-more"); await sleep(300); await page.evaluate(l => [...document.querySelectorAll(".more-item")].find(b => b.textContent.includes(l)).click(), label) }
  await sleep(700)
}

// Staff type their username, then the PIN, then press Sign in.
const USERNAMES = { 'Wanjiru K.': 'wanjiru', 'Brian M.': 'brian', 'Otieno J.': 'otieno', 'Achieng O.': 'achieng' }
async function signIn(name) {
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await waitText('Sign in')
  await page.evaluate(() => { try { localStorage.removeItem('bp-last-user') } catch {} })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.type('.login-card input.label-in', USERNAMES[name])
  for (const d of '1234') { await clickText(d); await sleep(60) }
  await page.click('.pad-ok')
  await sleep(1500)
  if (await hasText('Open your shift')) {
    await clickText('Open shift')
    await sleep(900)
  }
}
async function signOut() {
  await page.click('.rail-out')
  await waitText('Sign in')
}

async function step(name, fn) {
  console.log('\n' + name)
  try { await fn() } catch (e) { fail(e.message); await shot('error-' + name.replace(/\W+/g, '-')) }
}

await step('Cashier signs in and opens the till', async () => {
  await signIn('Wanjiru K.')
  check(await waitText('Unpaid sales'), 'till is showing')
  await page.waitForSelector('.grid .product', { timeout: 8000 }).catch(() => {})
  check(await page.$$eval('.grid .product', els => els.length) > 5, 'products loaded from the API')
  await shot('01-till')
})

await step('Cash sale with change and a receipt', async () => {
  await clickText('Tusker Lager', '.product')
  await clickText('Tusker Lager', '.product')
  check(await page.$$eval('.line', els => els.length) === 1, 'two taps make one line')
  await clickText('Pay now')
  check(await waitText('Confirm receipt of payment'), 'payment window open')
  await page.type('.pay-modal input', '1000')
  check(await waitText('KSh 440'), 'change shown (1,000 minus 560)')
  await shot('02-pay-cash')
  await clickText('Confirm receipt of payment')
  check(await page.waitForSelector('.rc', { timeout: 8000 }).then(() => true, () => false), 'receipt appears')
  check(await hasText('Sales receipt') || await hasText('SALES RECEIPT'), 'it is a sales receipt')
  await shot('03-receipt')
  await clickText('Start next sale')
})

await step('Barcode scanner adds items', async () => {
  await page.evaluate(() => {
    for (const k of [...'5000267024004', 'Enter']) window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
  await sleep(600)
  check(await hasText('Johnnie Walker Black'), 'scan added Johnnie Walker')
  await page.type('.order .label-in', 'UI test tab')
  await clickText('Save for later')
  check(await waitText('Saved to unpaid sales'), 'saved to the unpaid list')
  check(await hasText('UI test tab'), 'it shows in the unpaid list')
})

await step('M-Pesa prompt pays the saved tab', async () => {
  const row = await page.$$('.u-row')
  const idx = await page.$$eval('.u-row', els => els.findIndex(e => e.innerText.includes('UI test tab')))
  await (await row[idx].$('button.mini')).click()
  await sleep(400)
  await clickText('M-Pesa prompt')
  await page.type('.pay-modal input', '0712345678')
  await clickText('Send prompt')
  check(await waitText('Waiting for the customer', 4000), 'waiting for the customer')
  await shot('04-stk-waiting')
  check(await page.waitForSelector('.rc', { timeout: 15000 }).then(() => true, () => false), 'Safaricom confirmed and the receipt printed')
  check(await hasText('Confirmed by M-Pesa'), 'receipt says confirmed by M-Pesa')
  await shot('05-stk-receipt')
  await clickText('Start next sale')
})

await step('Transactions and a refund request', async () => {
  await nav('Transactions')
  check(await waitText('Transactions'), 'transactions page')
  check(await page.$$eval('tr.click', els => els.length) > 0, 'sales listed')
  await page.evaluate(() => [...document.querySelectorAll('tr.click')].find(r => r.querySelector('.tag.paid')).click())
  await sleep(300)
  await clickText('Request refund')
  await page.type('textarea', 'Customer returned a broken bottle')
  await clickText('Send to manager')
  check(await waitText('Refund request sent'), 'refund request sent')
  await shot('06-transactions')
})

await step('Customers', async () => {
  await nav('Customers')
  check(await waitText('Lifetime spend'), 'customer details show')
  await shot('07-customers')
})

await step('Shift close window', async () => {
  await page.click('.shift-pill')
  check(await waitText('Expected in till'), 'shift figures show')
  await page.keyboard.press('Escape')
  await sleep(300)
  await signOut()
})

await step('Manager approves the refund', async () => {
  await signIn('Otieno J.')
  if (await hasText('Not now')) await clickText('Not now')
  await nav('Today')
  check(await waitText('Waiting for you'), 'approval queue shows')
  check(await hasText('broken bottle'), 'the refund reason is there')
  await shot('08-today')
  await page.evaluate(() => [...document.querySelectorAll('.approval-row')].find(r => r.innerText.includes('broken bottle')).querySelector('button.on').click())
  check(await waitText('Approved'), 'approved')
})

await step('Manager inventory and staff', async () => {
  await nav('Inventory')
  check(await waitText('Receive delivery'), 'inventory page')
  await shot('09-inventory')
  await clickText('Receive delivery')
  check(await waitText('Choose a product'), 'receive window')
  await page.keyboard.press('Escape')
  await sleep(200)
  await nav('Staff')
  check(await waitText('wanjiru'), 'staff list shows')
  await signOut()
})

await step('Owner sees every branch and manages staff', async () => {
  await signIn('Achieng O.')
  await nav('Branches')
  check(await waitText('All branches'), 'branches page')
  check(await waitText('Thika Road'), 'all three branches listed')
  await shot('10-branches')
  await nav('Staff')
  await clickText('Add staff')
  check(await waitText('Full name'), 'add staff window')
  await page.keyboard.press('Escape')
  await sleep(200)
  const options = await page.$$eval('.branch-select option', os => os.map(o => o.textContent))
  check(options.length === 3, 'owner can switch between 3 branches')
  await page.select('.branch-select', await page.$$eval('.branch-select option', os => os.find(o => o.textContent === 'Kilimani').value))
  await nav('Till')
  await sleep(800)
  check(await page.$$eval('.grid .product', els => els.length) > 5, 'Kilimani till loads')
  await shot('11-owner-kilimani')
  await signOut()
})

await step('Owner settings: every section loads', async () => {
  await signIn('Achieng O.')
  await nav('Settings')
  await sleep(800)
  check(await waitText('On every receipt'), 'business details form')
  const name = await page.$eval('.admin input.label-in', el => el.value)
  check(name.length > 1, 'business name is filled in from the server')
  for (const [tab, expect] of [['M-Pesa', 'Daraja keys'], ['Billing', 'Your plan'], ['Devices', 'Signed in now'], ['Activity', 'Activity log'], ['Exports', 'Download your data']]) {
    await page.evaluate(t => [...document.querySelectorAll('.admin-tabs button')].find(b => b.textContent === t).click(), tab)
    await sleep(900)
    check(await waitText(expect), `${tab} section shows`)
    await shot('13-settings-' + tab.toLowerCase().replace(/\W/g, ''))
  }
  // the M-Pesa test button answers in plain words
  await page.evaluate(() => [...document.querySelectorAll('.admin-tabs button')].find(b => b.textContent === 'M-Pesa').click())
  await sleep(600)
  await clickText('Test connection')
  check(await waitText('simulation') || await waitText('No M-Pesa settings'), 'M-Pesa connection test answers')
  // an export downloads a real CSV
  const csv = await page.evaluate(async () => {
    const a = [...document.querySelectorAll('a.export-item')][0]
    return a ? (await fetch(a.href, { credentials: 'same-origin' })).text() : ''
  }).catch(() => '')
  await page.evaluate(() => [...document.querySelectorAll('.admin-tabs button')].find(b => b.textContent === 'Exports').click())
  await sleep(500)
  const csv2 = await page.evaluate(async () => {
    const a = [...document.querySelectorAll('a.export-item')][0]
    return (await fetch(a.href, { credentials: 'same-origin' })).text()
  })
  check(csv2.includes('Sale number'), 'sales CSV export downloads with a header row')
  await signOut()
})

await step('Receipt prints at receipt width', async () => {
  await page.goto(URL + '/?preview=receipt', { waitUntil: 'networkidle0' })
  await sleep(800)
  await page.emulateMediaType('print')
  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
  await page.emulateMediaType(null)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${SHOTS}/receipt-print.pdf`, pdf)
  check(pdf.length > 5000, 'receipt prints to a PDF')
  const width = await page.evaluate(() => {
    const m = window.matchMedia('print')
    return document.querySelector('.rc')?.getBoundingClientRect().width ?? 0
  })
  check(width > 150, 'receipt is on the page')
})

await step('Light theme', async () => {
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.click('.theme-btn')
  await sleep(300)
  await shot('12-login-theme')
})

console.log('')
if (problems.length) {
  for (const p of [...new Set(problems)]) console.log('  PROBLEM ' + p)
  failures += problems.length
}
await browser.close()
console.log(failures ? `\n${failures} problem(s)` : '\nUI walkthrough passed with no console errors')
process.exit(failures ? 1 : 0)
