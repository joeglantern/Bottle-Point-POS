// Walks the console in Chrome against the real API, at desktop and phone
// sizes, and fails on console errors, server errors or sideways scrolling.
//   CONSOLE_EMAIL=... CONSOLE_PASSWORD=... node e2e/console.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const URL = process.env.CONSOLE_URL ?? 'http://localhost:5174'
const EMAIL = process.env.CONSOLE_EMAIL
const PASSWORD = process.env.CONSOLE_PASSWORD
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS = process.env.SHOTS ?? 'e2e/shots'
if (!EMAIL || !PASSWORD) {
  console.error('Set CONSOLE_EMAIL and CONSOLE_PASSWORD')
  process.exit(2)
}
mkdirSync(SHOTS, { recursive: true })

let failures = 0
const problems = []
const ok = m => console.log('  ok   ' + m)
const fail = m => { failures++; console.log('  FAIL ' + m) }
const check = (c, m) => (c ? ok(m) : fail(m))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage()
page.on('console', m => m.type() === 'error' && !/status of 401|favicon/.test(m.text()) && problems.push('console: ' + m.text()))
page.on('pageerror', e => problems.push('page error: ' + e.message))
page.on('response', r => r.url().includes('/api/') && r.status() >= 500 && problems.push(`server ${r.status()} on ${r.url()}`))

const text = () => page.evaluate(() => document.body.innerText.toLowerCase())
async function waitText(t, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if ((await text()).includes(t.toLowerCase())) return true; await sleep(120) }
  return false
}
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function settle() {
  await sleep(250)
  const end = Date.now() + 8000
  while (Date.now() < end && (await page.$('.cx-skeleton, .cx-figure.is-loading'))) await sleep(120)
  await sleep(200)
}

const VIEWS = [
  ['/', 'overview', 'Monthly recurring revenue'],
  ['/clients', 'clients', 'Kilele Liquor Store'],
  ['/subscriptions', 'subscriptions', 'Growth'],
  ['/invoices', 'invoices', 'Outstanding'],
  ['/plans', 'plans', 'Pay as you sell'],
  ['/team', 'team', 'admin@bottlepoint.local'],
  ['/audit', 'audit', 'What happened'],
  ['/account', 'account', 'Change password']
]

console.log('\nSign in')
await page.setViewport({ width: 1440, height: 900 })
await page.goto(URL, { waitUntil: 'networkidle0' })
check(await waitText('Sign in'), 'sign in screen shows')
await page.type('#cx-email', EMAIL)
await page.type('#cx-password', 'not-the-password')
await page.click('button[type=submit]')
check(await waitText('Wrong email or password'), 'wrong password is refused with a clear message')
await page.click('#cx-password', { clickCount: 3 })
await page.type('#cx-password', PASSWORD)
await page.click('button[type=submit]')
check(await waitText('Monthly recurring revenue', 10000), 'signed in, overview loads')

for (const [w, h, label, touch] of [[1440, 900, 'desktop', false], [390, 844, 'phone', true]]) {
  console.log(`\n${label} ${w}x${h}`)
  await page.setViewport({ width: w, height: h, isMobile: touch, hasTouch: touch })
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { localStorage.setItem('bp-theme', t) }, theme)
    for (const [path, name, expect] of VIEWS) {
      await page.goto(URL + path, { waitUntil: 'networkidle0' })
      await settle()
      const seen = await waitText(expect, 6000)
      check(seen, `${name} (${theme}) shows "${expect}"`)
      check(await noOverflow(), `${name} (${theme}) has no sideways scroll`)
      await page.screenshot({ path: `${SHOTS}/${label}-${theme}-${name}.png`, fullPage: label === 'desktop' })
    }
  }
}

console.log('\nClient page and dialogs')
await page.setViewport({ width: 1440, height: 900 })
await page.goto(URL + '/clients', { waitUntil: 'networkidle0' })
await settle()
await page.evaluate(() => [...document.querySelectorAll('a.cx-strong-link')].find(a => a.textContent.includes('Pwani')).click())
check(await waitText('Usage'), 'client detail opens')
await page.screenshot({ path: `${SHOTS}/desktop-client.png`, fullPage: true })
for (const tab of ['Subscription', 'Invoices', 'People', 'Notes', 'Activity']) {
  await page.evaluate(t => [...document.querySelectorAll('[role=tab]')].find(b => b.textContent.startsWith(t)).click(), tab)
  await settle()
  check(!(await page.$('.cx-errorstate')), `${tab} tab loads without error`)
  await page.screenshot({ path: `${SHOTS}/desktop-client-${tab.toLowerCase()}.png`, fullPage: true })
}
await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].find(b => b.textContent.startsWith('Notes')).click())
await settle()
await page.type('#cx-note', 'Called the owner about the overdue invoice. Will pay Friday.')
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Add note').click())
check(await waitText('Will pay Friday'), 'a note can be added')

await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Change plan').click())
check(await waitText('The change applies now'), 'change plan dialog opens')
await page.screenshot({ path: `${SHOTS}/desktop-dialog-plan.png` })
await page.keyboard.press('Escape')
await sleep(250)
check(!(await page.$('.cx-dialog')), 'Escape closes the dialog')

await page.goto(URL + '/plans', { waitUntil: 'networkidle0' })
await settle()
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('New plan')).click())
await sleep(300)
await page.evaluate(() => [...document.querySelectorAll('.cx-radio')].find(l => l.textContent.includes('Per branch')).click())
await page.type('input[placeholder="0"]', '1500')
const inputs = await page.$$('.cx-dialog input.cx-num[inputmode=decimal]')
await inputs[1].type('1000')
check(await waitText('KSh 1,500 a month plus KSh 1,000 per branch a month'), 'plan form shows the live price sentence')
await page.screenshot({ path: `${SHOTS}/desktop-dialog-newplan.png` })
await page.keyboard.press('Escape')

await page.goto(URL + '/invoices', { waitUntil: 'networkidle0' })
await settle()
await page.evaluate(() => document.querySelector('a.cx-strong-link').click())
check(await waitText('Balance due'), 'invoice document opens')
await page.screenshot({ path: `${SHOTS}/desktop-invoice.png`, fullPage: true })

console.log('\nNavigation')
await page.goBack()
check(await waitText('Outstanding'), 'back button returns to the list')
await page.goto(URL + '/nowhere', { waitUntil: 'networkidle0' })
check(await waitText('Page not found'), 'unknown address shows not found')
await page.keyboard.press('/')
await sleep(200)
await page.keyboard.type('kil')
check(await waitText('Kilele Liquor Store'), 'search finds a client')
await page.screenshot({ path: `${SHOTS}/desktop-search.png` })

console.log('')
if (problems.length) { for (const p of [...new Set(problems)]) console.log('  PROBLEM ' + p); failures += problems.length }
await browser.close()
console.log(failures ? `\n${failures} problem(s)` : '\nConsole walkthrough passed')
process.exit(failures ? 1 : 0)
