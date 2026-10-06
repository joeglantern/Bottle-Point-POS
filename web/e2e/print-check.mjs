// Prints the receipt on thermal sized pages and checks nothing spills past
// the printable width. node e2e/print-check.mjs (POS dev server running)
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const p = await b.newPage()
await p.goto('http://localhost:5173/?preview=receipt', { waitUntil: 'networkidle0' })
let bad = 0
for (const [paper, printable] of [['80', 72], ['58', 48]]) {
  await p.evaluate(w => { document.documentElement.dataset.paper = w }, paper)
  await p.emulateMediaType('print')
  const over = await p.evaluate(mm => {
    const px = mm * 96 / 25.4 + 1
    const rc = document.querySelector('.rc').getBoundingClientRect()
    return [...document.querySelectorAll('.rc *')].filter(el => el.getBoundingClientRect().right - rc.left > px).map(el => el.className || el.tagName).slice(0, 5)
  }, printable)
  const pdf = await p.pdf({ width: paper + 'mm', height: '260mm', printBackground: true, pageRanges: '1' })
  writeFileSync(`e2e/shots/receipt-${paper}mm.pdf`, pdf)
  console.log(`${paper}mm paper: ${over.length ? 'SPILLS PAST ' + printable + 'mm: ' + over.join(', ') : 'fits inside ' + printable + 'mm'}`)
  if (over.length) bad++
  await p.emulateMediaType(null)
}
await b.close()
process.exit(bad ? 1 : 0)
