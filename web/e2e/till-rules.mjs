// The owner's till rules: stock tracking and the M-Pesa code.
//   (API on :3000 with the demo seed, web dev server)
//   node e2e/till-rules.mjs
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
  const ok = await page.evaluate((label, sel) => { const all = [...document.querySelectorAll(sel)].filter(x => !x.disabled); const b = all.find(x => x.textContent.trim() === label || x.getAttribute('aria-label') === label) ?? all.find(x => x.textContent.includes(label)); if (b) b.click(); return !!b }, label, sel)
  if (!ok) throw new Error('could not click ' + label)
  await sleep(700)
}
const toggle = name => page.evaluate(n => [...document.querySelectorAll('label.toggle')].find(l => l.textContent.includes(n)).querySelector('input').click(), name)
const isOn = name => page.evaluate(n => [...document.querySelectorAll('label.toggle')].find(l => l.textContent.includes(n)).querySelector('input').checked, name)

try {
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.evaluate(() => { try { localStorage.removeItem('bp-last-user') } catch {} })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.type('.login-card input.label-in', 'achieng')
  for (const d of '1234') await click(d)
  await page.click('.pad-ok')
  await sleep(1800)
  if ((await text()).includes('Open your shift')) await click('Open shift')
  await click('Settings', '.rail button')
  if (!(await isOn('Track stock'))) { await toggle('Track stock'); await sleep(1200) }
  if (await isOn('Require the M-Pesa code')) { await toggle('Require the M-Pesa code'); await sleep(1200) }
  check(!(await isOn('Require the M-Pesa code')), 'owner switched off the M-Pesa code requirement')

  await click('Till', '.rail button'); await sleep(1500)
  // an out of stock product cannot go into a sale
  const out = await page.evaluate(() => [...document.querySelectorAll('.product')].find(p => p.textContent.includes('Out of stock'))?.querySelector('b')?.textContent)
  if (out) {
    await click(out, '.product')
    check((await text()).includes(`${out} is out of stock`), `tapping ${out} (out of stock) says so`)
    check(!(await page.$$eval('.line', ls => ls.length)), 'and nothing was added')
  } else check(false, 'found an out of stock product to try')

  // M-Pesa by amount alone
  await click('Tusker Lager', '.product')
  await click('Pay now')
  await click('M-Pesa', '.pay-modal .seg button')
  check((await text()).toLowerCase().includes('m-pesa code (optional)'), 'the code is optional')
  await click('Confirm receipt of payment')
  check(await page.waitForSelector('.rc', { timeout: 8000 }).then(() => true, () => false), 'paid by M-Pesa without a code, receipt shows')
  check((await text()).includes('Received at till'), 'the receipt says it was received at the till')
  await click('Start next sale')

  // back to requiring the code
  await click('Settings', '.rail button')
  await toggle('Require the M-Pesa code'); await sleep(1200)
  check(await isOn('Require the M-Pesa code'), 'switched back on')
} catch (e) {
  check(false, e.message)
  await page.screenshot({ path: 'e2e/shots/till-rules-error.png' })
}
for (const e of errors) check(false, 'page error: ' + e)
await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
