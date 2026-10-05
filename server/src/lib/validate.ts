import type { Context } from 'hono'
import { z } from 'zod'
import { badRequest } from './errors.js'

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw badRequest('Invalid input.', z.flattenError(r.error))
  return r.data
}

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let data: unknown
  try {
    data = await c.req.json()
  } catch {
    throw badRequest('Body must be JSON.')
  }
  return parse(schema, data)
}

export const query = <T extends z.ZodType>(c: Context, schema: T): z.infer<T> => parse(schema, c.req.query())

// Shared field rules
export const cents = z.number().int().min(0).max(1_000_000_000)
export const positiveCents = z.number().int().min(1).max(1_000_000_000)
export const id = z.string().min(1).max(64)
// Safaricom receipt codes: 10 upper case letters or digits
export const mpesaCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'M-Pesa code must be 10 letters or digits')
// Kenyan phone, normalised to 2547XXXXXXXX / 2541XXXXXXXX
export const phone = z
  .string()
  .trim()
  .transform(s => s.replace(/[\s-]/g, ''))
  .transform(s => (s.startsWith('+') ? s.slice(1) : s))
  .transform(s => (s.startsWith('0') ? '254' + s.slice(1) : s))
  .refine(s => /^254(7|1)\d{8}$/.test(s), 'Enter a valid Safaricom number, for example 0712 345 678')
