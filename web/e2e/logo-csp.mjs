// The logo upload under the live site's Content-Security-Policy (from
// deploy/nginx.conf): shrinking a chosen file and reading its colours must
// not trip the policy.
//   node e2e/logo-csp.mjs
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
const PAGE = '<!doctype html><meta charset="utf-8"><script type="module">' +
  "import { logoFromFile, paletteFrom } from '/brand.js';" +
  "window.run = async () => { const blob = await (await fetch('/logo.png')).blob();" +
  " const file = new File([blob], 'logo.png', { type: 'image/png' });" +
  " const data = await logoFromFile(file); const colours = await paletteFrom(data); return { size: data.length, type: data.slice(0, 15), colours } }" +
  '</script>'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage()
await page.setRequestInterception(true)
page.on('request', r => {
  const p = new URL(r.url()).pathname
  const headers = { 'content-security-policy': CSP }
  if (p === '/') return r.respond({ status: 200, contentType: 'text/html', headers, body: PAGE })
  if (p === '/brand.js') return r.respond({ status: 200, contentType: 'text/javascript', headers, body: readFileSync('src/brand.js') })
  if (p === '/logo.png') return r.respond({ status: 200, contentType: 'image/png', headers, body: readFileSync('public/brand/icon-512.png') })
  r.abort()
})
const violations = []
await page.exposeFunction('reportViolation', v => violations.push(v))
await page.evaluateOnNewDocument(() => document.addEventListener('securitypolicyviolation', e => window.reportViolation(e.violatedDirective + ' ' + e.blockedURI)))
await page.goto('http://bp.test/', { waitUntil: 'networkidle0' })
const out = await page.evaluate(() => window.run()).catch(e => ({ error: e.message }))
console.log(JSON.stringify(out))
let failures = 0
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++ }
check(!out.error, 'the chosen file is read and shrunk' + (out.error ? ': ' + out.error : ''))
check(out.size > 0 && out.size < 90_000, 'small enough to upload')
check(Array.isArray(out.colours), 'colours read from it: ' + (out.colours ?? []).join(' '))
check(!violations.length, 'no security policy violation' + (violations.length ? ': ' + violations.join(', ') : ''))
await browser.close()
process.exit(failures ? 1 : 0)
