// Switching stock tracking off and on, as the owner.
//   (API on :3000 with the demo seed, web dev server)
//   node e2e/track-stock.mjs
import puppeteer from 'puppeteer-core'

const URL = process.env.UI_URL ?? 'http://127.0.0.1:5173'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
let failures = 0
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const text = () => page.evaluate(() => document.body.innerText)
const click = async (label, sel = 'button') => {
  const ok = await page.evaluate((label, sel) => { const b = [...document.querySelectorAll(sel)].find(x => x.textContent.trim() === label || x.getAttribute('aria-label') === label); if (b) b.click(); return !!b }, label, sel)
  if (!ok) throw new Error('no ' + label)
  await sleep(700)
}
const toggle = () => page.evaluate(() => [...document.querySelectorAll('label.toggle')].find(l => l.textContent.includes('Track stock')).querySelector('input').click())

try {
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.evaluate(() => { try { localStorage.removeItem('bp-last-user') } catch {} })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.type('.login-card input.label-in', 'achieng')
  for (const d of '1234') await click(d)
  await page.click('.pad-ok')
  await sleep(1800)
  if ((await text()).includes('Open your shift')) await click('Not now').catch(() => click('Open shift'))
  await click('Settings', '.rail button')
  check((await text()).includes('Track stock levels'), 'the owner sees the switch in Settings, Business')
  await toggle(); await sleep(1500)
  await click('Till', '.rail button'); await sleep(1500)
  const t = await text()
  check(!/in stock|Out of stock/i.test(t), 'with tracking off the till shows no stock levels')
  await click('Inventory', '.rail button'); await sleep(1200)
  check((await text()).includes('Stock levels are switched off'), 'Inventory says tracking is off')
  await click('Settings', '.rail button')
  await toggle(); await sleep(1500)
  await click('Till', '.rail button'); await sleep(1500)
  check(/in stock/i.test(await text()), 'switched back on, stock levels return')
} catch (e) {
  check(false, e.message)
}
for (const e of errors) check(false, 'page error: ' + e)
await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
