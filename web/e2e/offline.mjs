// The till with no internet at all, end to end, on the production build:
//   API on :3000 with the demo seed (trusting http://127.0.0.1:4173), then
//   npm run build && node e2e/offline.mjs
//
// This script runs the till's web server itself, so it can switch it off: a
// real outage, where even reloading the page has to work from the device.

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const PORT = 4173
const URL = `http://127.0.0.1:${PORT}`
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS = 'e2e/shots'
mkdirSync(SHOTS, { recursive: true })

let failures = 0
const problems = []
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- the till's web server, which we switch off and on ----------
let server = null
async function serverUp() {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    env: { ...process.env, API_URL: 'http://127.0.0.1:3000' },
    stdio: 'ignore'
  })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL + '/api/health')).ok) return } catch {}
    await sleep(250)
  }
  throw new Error('till server did not start')
}
async function serverDown() {
  if (!server) return
  server.kill()
  await new Promise(r => server.once('exit', r))
  server = null
  for (let i = 0; i < 40; i++) {
    try { await fetch(URL + '/', { signal: AbortSignal.timeout(500) }) } catch { return }
    await sleep(250)
  }
}

// ---------- browser helpers ----------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'bp-offline-')),
  args: ['--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 }
})
const page = await browser.newPage()
page.on('pageerror', e => problems.push('page error: ' + e.message))
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` })
const hasText = t => page.evaluate(t => document.body.innerText.toLowerCase().includes(t.toLowerCase()), t)
async function waitText(t, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await hasText(t)) return true; await sleep(200) } return false }
async function clickText(text, sel = 'button') {
  const ok = await page.evaluate((text, sel) => {
    const el = [...document.querySelectorAll(sel)].filter(b => !b.disabled).find(b => b.textContent.trim() === text) ??
      [...document.querySelectorAll(sel)].filter(b => !b.disabled).find(b => b.textContent.includes(text))
    if (!el) return false
    el.click()
    return true
  }, text, sel)
  if (!ok) throw new Error(`could not click "${text}"`)
  await sleep(300)
}
const idb = (store, key) =>
  page.evaluate((store, key) => new Promise((resolve, reject) => {
    const r = indexedDB.open('bottle-point')
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const db = r.result
      if (!db.objectStoreNames.contains(store)) { db.close(); return resolve(null) }
      const q = key == null ? db.transaction(store).objectStore(store).getAll() : db.transaction(store).objectStore(store).get(key)
      q.onsuccess = () => { resolve(q.result); db.close() }
      q.onerror = () => reject(q.error)
    }
  }), store, key)

async function signIn(username, pin = '1234') {
  await page.waitForSelector('.login-card input.label-in', { timeout: 15000 })
  await page.$eval('.login-card input.label-in', el => { el.value = '' })
  await page.evaluate(() => { const b = document.querySelector('.login-clear'); if (b) b.click() })
  await page.type('.login-card input.label-in', username)
  for (const d of pin) await clickText(d)
  await page.click('.pad-ok')
  await sleep(1800)
}
async function openShiftIfAsked() {
  if (await hasText('Open your shift')) { await clickText('Open shift'); await sleep(1200) }
}
async function step(name, fn) {
  console.log('\n' + name)
  try { await fn() } catch (e) { check(false, e.message); await shot('offline-error-' + name.replace(/\W+/g, '-')) }
}

let paidRef = null
let tabRef = null

try {
  await serverUp()

  await step('Signed in once with internet: the till registers itself', async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' })
    await page.evaluate(() => { try { localStorage.removeItem('bp-last-user') } catch {} })
    await page.goto(URL, { waitUntil: 'networkidle0' })
    await signIn('wanjiru')
    await openShiftIfAsked()
    check(await waitText('Unpaid'), 'till is showing')
    let device = null
    for (let i = 0; i < 40 && !device; i++) { device = await idb('kv', 'device'); if (!device) await sleep(250) }
    check(!!device?.code && /^T\d+$/.test(device.code), `till registered as ${device?.code}`)
    check(!!(await idb('kv', 'pins'))?.wanjiru, 'a PIN check is kept for offline sign in, never the PIN itself')
    check(!JSON.stringify(await idb('kv', 'pins')).includes('"1234"'), 'the PIN itself is not stored')
    // the service worker takes over the page, so it can open without internet
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload({ waitUntil: 'networkidle0' })
    await openShiftIfAsked()
    check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'app files are kept on the device')
    await page.waitForSelector('.grid .product', { timeout: 10000 })
    await sleep(1000)
  })

  await step('The internet goes down and the page is reloaded', async () => {
    await serverDown()
    await page.reload({ waitUntil: 'domcontentloaded' })
    check(await waitText('Unpaid', 15000), 'the till still opens, with the same person signed in')
    check(await waitText('Offline.', 8000), 'it says plainly that it is offline and selling carries on')
    check((await page.$$('.grid .product')).length > 5, 'products come from the till')
    await shot('offline-01-till')
  })

  await step('A cash sale offline, with a receipt', async () => {
    await clickText('Tusker Lager', '.product')
    await clickText('Tusker Lager', '.product')
    await clickText('Pay now')
    check(await waitText('Confirm receipt of payment'), 'payment window open')
    const tabs = await page.$$eval('.pay-modal .seg button', bs => bs.map(b => b.textContent.trim()))
    check(!tabs.includes('M-Pesa prompt'), 'no M-Pesa prompt offline: ' + tabs.join(', '))
    await page.type('.pay-modal input', '1000')
    await clickText('Confirm receipt of payment')
    check(await page.waitForSelector('.rc', { timeout: 8000 }).then(() => true, () => false), 'receipt appears')
    paidRef = await page.$eval('.rc-ref', el => el.textContent.trim()).catch(() => null)
    check(/^T\d+-\d{4}$/.test(paidRef ?? ''), `receipt carries the till's number ${paidRef}`)
    await shot('offline-02-receipt')
    await clickText('Start next sale')
  })

  await step('A tab saved offline', async () => {
    await clickText('Gilbey', '.product')
    await clickText('Save for later')
    await sleep(800)
    tabRef = await page.evaluate(() => [...document.querySelectorAll('.u-main b')].map(b => b.textContent).find(t => /#T\d+-/.test(t)))
    check(!!tabRef, `it is in the unpaid list as ${tabRef}`)
    const waiting = (await idb('outbox')).length
    check(waiting >= 2, `${waiting} items waiting to send`)
  })

  await step('Signing out and in without internet', async () => {
    await page.click('.rail-out')
    check(await waitText('No internet', 8000), 'sign in screen says only people known to this till can sign in')
    await signIn('brian')
    check(await waitText('cannot sign in offline'), 'someone who never signed in on this till cannot sign in')
    await signIn('wanjiru', '9999')
    check(await waitText('Wrong username or PIN'), 'a wrong PIN is refused')
    await signIn('wanjiru')
    check(await waitText('Unpaid', 8000), 'the right PIN works offline')
  })

  await step('The internet comes back', async () => {
    await serverUp()
    let left = -1
    for (let i = 0; i < 120; i++) { left = (await idb('outbox')).length; if (left === 0) break; await sleep(500) }
    check(left === 0, 'everything was sent')
    check((await idb('failed')).length === 0, 'nothing was refused')
    check(await waitText('Enter your PIN to carry on', 15000), 'the cashier is asked for their PIN once, to get a real session')
    await signIn('wanjiru')
    await openShiftIfAsked()
    check(await waitText('Unpaid', 8000), 'back to normal')
    const found = await page.evaluate(async ref => (await (await fetch('/api/sales?q=' + ref, { credentials: 'same-origin' })).json()).sales, paidRef)
    check(found?.length === 1 && found[0].status === 'PAID' && found[0].number > 1000, `the offline sale is on the server as #${found?.[0]?.number}, paid`)
    const ref = tabRef?.match(/T\d+-\d+/)?.[0]
    const tab = await page.evaluate(async ref => (await (await fetch('/api/sales?q=' + ref, { credentials: 'same-origin' })).json()).sales, ref)
    check(tab?.length === 1 && tab[0].status === 'SAVED', 'the offline tab is on the server, unpaid')
    // sending again changes nothing (the server recognises every item)
    check(await page.evaluate(async ref => (await (await fetch('/api/sales?q=' + ref, { credentials: 'same-origin' })).json()).sales.length, paidRef) === 1, 'recorded exactly once')
    await shot('offline-03-back-online')
  })

  // ---------- the server stays up but the till's connection fails ----------
  const cut = async on => {
    await page.setRequestInterception(on)
    if (on) page.on('request', block)
    else page.off('request', block)
  }
  const block = r => (r.url().includes('/api/') || r.url().includes('/socket.io/') ? r.abort('internetdisconnected') : r.continue())
  const apiGet = path => page.evaluate(async path => (await fetch('/api' + path, { credentials: 'same-origin' })).json(), path)
  const waitSent = async () => {
    for (let i = 0; i < 120; i++) { if (!(await idb('outbox')).length) return true; await sleep(500) }
    return false
  }

  let tabNo = null
  await step('A tab saved with internet is paid after the connection drops', async () => {
    await clickText('Hennessy', '.product')
    await clickText('Save for later')
    await sleep(1200)
    tabNo = await page.evaluate(() => [...document.querySelectorAll('.u-main b')].map(b => b.textContent.trim()).find(t => /^#\d+/.test(t)))
    check(!!tabNo, `saved online as ${tabNo}`)
    await cut(true)
    await page.evaluate(no => [...document.querySelectorAll('.u-main')].find(el => el.textContent.includes(no.split(' ')[0])).click(), tabNo)
    await sleep(500)
    await clickText('Pay now')
    check(await waitText('Confirm receipt of payment'), 'payment window opens without internet')
    await page.type('.pay-modal input', '10000')
    await clickText('Confirm receipt of payment')
    check(await page.waitForSelector('.rc', { timeout: 10000 }).then(() => true, () => false), 'receipt appears')
    check(await waitText('Offline.', 12000), 'the till noticed it is offline')
    await clickText('Start next sale')
    await cut(false)
    check(await waitSent(), 'the payment was sent when the connection came back')
    const no = Number(tabNo.match(/\d+/)[0])
    const sale = (await apiGet('/sales?q=' + no)).sales?.find(s => s.number === no)
    check(sale?.status === 'PAID', `sale ${tabNo} is paid on the server`)
    const issues = await apiGet('/offline/issues').catch(() => null)
    check(!issues?.issues?.length, 'nothing for a manager to check')
  })

  await step('A shift opened offline, with cash taken in it', async () => {
    const current = (await apiGet('/shifts/current')).shift
    if (current) {
      await page.evaluate(async (id, cents) => fetch('/api/shifts/' + id + '/close', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ countedCashCents: cents }) }), current.id, Math.max(0, current.expectedCashCents))
    }
    await page.reload({ waitUntil: 'networkidle0' })
    await sleep(800)
    await serverDown()
    await page.reload({ waitUntil: 'domcontentloaded' })
    check(await waitText('Open your shift', 15000), 'offline, with no shift, the till asks to open one')
    await clickText('Open shift')
    await sleep(800)
    await clickText('Tusker Lager', '.product')
    await clickText('Pay now')
    await page.type('.pay-modal input', '500')
    await clickText('Confirm receipt of payment')
    check(await page.waitForSelector('.rc', { timeout: 8000 }).then(() => true, () => false), 'cash sale in the offline shift')
    await clickText('Start next sale')
    await serverUp()
    check(await waitSent(), 'shift and sale were sent')
    check(await waitText('Enter your PIN to carry on', 15000), 'PIN asked once')
    await signIn('wanjiru')
    const shift = (await apiGet('/shifts/current')).shift
    check(shift?.open && shift.cashTakenCents >= 28000, `the shift is on the server with its cash (${shift?.cashTakenCents / 100})`)
  })
} catch (e) {
  check(false, e.message)
  await shot('offline-error')
} finally {
  for (const p of problems) check(false, p)
  await browser.close()
  await serverDown()
}
console.log(failures ? `\n${failures} failed` : '\nOffline walkthrough passed')
process.exit(failures ? 1 : 0)
