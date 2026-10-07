// Adding products by scanning, and the payment screen without M-Pesa prompts.
//   (API on :3000 with the demo seed, web dev server on :5173)
//   node e2e/scan-add.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const URL = process.env.UI_URL ?? 'http://localhost:5173'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS = 'e2e/shots'
mkdirSync(SHOTS, { recursive: true })
let failures = 0
const problems = []
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } })
const page = await browser.newPage()
page.on('pageerror', e => problems.push('page error: ' + e.message))
page.on('response', r => r.url().includes('/api/') && r.status() >= 500 && problems.push(`server ${r.status()} on ${r.url()}`))
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` })
const hasText = t => page.evaluate(t => document.body.innerText.toLowerCase().includes(t.toLowerCase()), t)
async function waitText(t, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await hasText(t)) return true; await sleep(150) } return false }
async function clickText(text, sel = 'button') {
  const ok = await page.evaluate((text, sel) => {
    const el = [...document.querySelectorAll(sel)].filter(b => !b.disabled).find(b => b.textContent.trim() === text || b.textContent.includes(text))
    if (!el) return false
    el.click(); return true
  }, text, sel)
  if (!ok) throw new Error(`could not click "${text}"`)
  await sleep(300)
}
// a USB scanner: the digits very fast, then Enter, into whatever has focus
async function scan(code) { await page.keyboard.type(code, { delay: 0 }); await page.keyboard.press('Enter'); await sleep(500) }

async function signIn(username) {
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.evaluate(() => { try { localStorage.removeItem('bp-last-user') } catch {} })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.type('.login-card input.label-in', username)
  for (const d of '1234') await clickText(d)
  await page.click('.pad-ok')
  await sleep(1500)
  if (await hasText('Open your shift')) { await clickText('Open shift'); await sleep(900) }
}
const code = '0' + String(Date.now()).slice(-11) // 12 digits, new every run

try {
  console.log('\nManager scans a new bottle on the Inventory page')
  await signIn('otieno')
  await page.click('.rail button[aria-label="Inventory"]')
  await sleep(1200)
  await page.click('body')
  await scan(code)
  check(await waitText('Add product'), 'scanning an unknown bottle opens Add product')
  check(await page.$eval('.input-clear input', el => el.value) === code, 'barcode is filled in')
  // the name box has focus; a second scan must not land in it or double the barcode
  await scan(code)
  check(await page.$eval('.input-clear input', el => el.value) === code, 'scanning again keeps one barcode')
  check(await page.$eval('.modal input.label-in', el => el.value) === '', 'the name box stays clean')
  check(await hasText('Enter the product name'), 'the form says what is missing')
  await page.type('.modal input.label-in', 'Test Scan Whisky')
  const inputs = await page.$$('.modal input')
  await inputs[1].type('Whisky')
  await inputs[2].type('750')
  await page.type('.modal input[inputmode="decimal"]', '2500')
  await shot('scan-01-add-product')
  await clickText('Save', '.modal button')
  check(await waitText('Product added'), 'product saved')
  await sleep(800)
  await scan(code)
  check(await waitText('Edit product'), 'scanning it again opens the product to edit')
  await page.keyboard.press('Escape'); await sleep(400)

  console.log('\nThe till finds it by scan, and offers to add an unknown bottle')
  await page.click('.rail button[aria-label="Till"]')
  await sleep(1500)
  await page.click('body')
  await scan(code)
  check(await waitText('added Test Scan Whisky'), 'till scan adds the new product to the sale')
  const unknown = '0' + String(Date.now() + 7).slice(-11)
  await scan(unknown)
  check(await waitText('Add product'), 'unknown bottle at the till opens Add product for a manager')
  await page.type('.modal input.label-in', 'Till Added Gin')
  const ins = await page.$$('.modal input')
  await ins[1].type('Gin')
  await page.type('.modal input[inputmode="decimal"]', '1200')
  await clickText('Save', '.modal button')
  check(await waitText('added') && await page.evaluate(() => [...document.querySelectorAll('.line')].some(l => l.textContent.includes('Till Added Gin'))), 'it goes straight into the sale')
  await shot('scan-02-till')

  console.log('\nPayment screen')
  await clickText('Pay now')
  await waitText('Cash')
  const tabs = await page.$$eval('.pay-modal .seg button', bs => bs.map(b => b.textContent.trim()))
  console.log('  tabs: ' + tabs.join(', '))
  check(tabs.includes('Cash') && tabs.includes('M-Pesa code'), 'cash and typed code are offered')
  await shot('scan-03-pay')
} catch (e) {
  check(false, e.message)
  await shot('scan-error')
}
for (const p of problems) check(false, p)
await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
