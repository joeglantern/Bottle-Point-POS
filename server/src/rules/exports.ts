// CSV building blocks for the owner's exports: escaping, spreadsheet formula
// neutralising, money as plain decimals, Nairobi dates and the date range.

import { z } from 'zod'
import { unprocessable } from '../lib/errors.js'
import { dateField, dayRange, todayNairobi } from './reports.js'

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export const EXPORT_BATCH = 500
export const MAX_RANGE_DAYS = 366

// A value we generated ourselves (money, counts): written as is, so a
// negative amount stays a number instead of gaining a leading quote.
export type Trusted = { trusted: string }
export type Cell = string | number | null | undefined | Trusted

// Integer cents to shillings with two decimals, no floats: 480000 is 4800.00.
export function money(cents: number | null | undefined): Trusted {
  if (cents == null) return { trusted: '' }
  const abs = Math.abs(cents)
  return { trusted: `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}` }
}

// Excel, Sheets and LibreOffice run a cell that starts with one of these.
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: Cell): string {
  let s: string
  if (value == null) s = ''
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : ''
  else if (typeof value === 'object') s = value.trusted
  else s = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const csvRow = (cells: Cell[]) => cells.map(csvCell).join(',') + '\r\n'

// 2026-10-05 and 14:03:27 on the Nairobi clock.
export function nairobiStamp(d: Date | null | undefined): [string, string] {
  if (!d) return ['', '']
  const iso = new Date(d.getTime() + NAIROBI_OFFSET_MS).toISOString()
  return [iso.slice(0, 10), iso.slice(11, 19)]
}

export const exportQuery = z.object({
  from: dateField.optional(),
  to: dateField.optional(),
  branchId: z.string().min(1).max(64).optional()
})

// The Nairobi days to export, both ends included. With nothing given it is
// the current month; with one end given the other is the end of today or the
// start of that month.
export function exportRange(q: { from?: string; to?: string }, now = new Date()) {
  const today = todayNairobi(now)
  let from = q.from
  let to = q.to
  if (!from && !to) {
    from = today.slice(0, 8) + '01'
    const [y, m] = today.split('-').map(Number) as [number, number]
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  } else if (!to) {
    to = today
  } else if (!from) {
    from = to.slice(0, 8) + '01'
  }
  const start = dayRange(from!).start
  const end = dayRange(to!).end
  if (start.getTime() >= end.getTime()) throw unprocessable('The from date must not be after the to date.', 'invalid_range')
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS)
  if (days > MAX_RANGE_DAYS) throw unprocessable(`An export covers at most ${MAX_RANGE_DAYS} days. Pick a shorter range.`, 'range_too_long')
  return { from: from!, to: to!, start, end }
}

// A CSV download that is written batch by batch as the client reads it, so a
// year of sales never sits in memory at once. Starts with a UTF-8 byte order
// mark so Excel reads the file as UTF-8.
export function csvResponse(filename: string, header: string[], batches: AsyncGenerator<Cell[][]>): Response {
  const enc = new TextEncoder()
  let started = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (!started) {
        started = true
        ctrl.enqueue(enc.encode('﻿' + csvRow(header)))
        return
      }
      const next = await batches.next()
      if (next.done) ctrl.close()
      else ctrl.enqueue(enc.encode(next.value.map(csvRow).join('')))
    },
    async cancel() {
      await batches.return(undefined)
    }
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store'
    }
  })
}
