// Small client for Safaricom Daraja (Lipa na M-Pesa Online, STK push).
// mock mode never touches the network so the app works offline and in tests.

import { randomBytes } from 'node:crypto'
import { env } from '../env.js'
import { AppError } from './errors.js'

export type DarajaMode = 'mock' | 'sandbox' | 'production'

export type DarajaConfig = {
  mode: DarajaMode
  consumerKey: string
  consumerSecret: string
  shortcode: string
  passkey: string
  transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
  partyB: string
  callbackUrl: string
  callbackToken: string
  timeoutMs: number
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type StkPushInput = {
  phone: string
  amountCents: number
  accountReference: string
  description: string
}

export type StkPushResult = {
  merchantRequestId: string
  checkoutRequestId: string
  customerMessage: string
}

// pending: Safaricom has no final answer yet
export type StkQueryResult =
  | { state: 'pending' }
  | {
      state: 'done'
      resultCode: number
      resultDesc: string
      // the real query API does not return these, the mock does
      receipt?: string
      amountCents?: number
      phone?: string
    }

const BASE_URL: Record<Exclude<DarajaMode, 'mock'>, string> = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke'
}

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000

// YYYYMMDDHHmmss in Africa/Nairobi time (UTC+3, no daylight saving)
export function darajaTimestamp(date = new Date()) {
  const d = new Date(date.getTime() + NAIROBI_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    String(d.getUTCFullYear()) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  )
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string) {
  return Buffer.from(shortcode + passkey + timestamp).toString('base64')
}

export function callbackUrlFor(cfg: Pick<DarajaConfig, 'callbackUrl' | 'callbackToken'>) {
  return `${cfg.callbackUrl.replace(/\/+$/, '')}/${cfg.callbackToken}`
}

// 10 character receipt like SJK4H7QW2P (mock only)
export function fakeReceipt() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(10)
  let s = 'S'
  for (let i = 1; i < 10; i++) s += chars[bytes[i]! % chars.length]
  return s
}

// What the mock Safaricom does, decided by the last digits of the phone.
export type MockPlan =
  | { outcome: 'success'; receipt: string }
  | { outcome: 'failed' }
  | { outcome: 'cancelled' }
  | { outcome: 'never' }

export function mockPlanFor(phone: string): MockPlan {
  if (phone.endsWith('000')) return { outcome: 'failed' }
  if (phone.endsWith('111')) return { outcome: 'cancelled' }
  if (phone.endsWith('222')) return { outcome: 'never' }
  return { outcome: 'success', receipt: fakeReceipt() }
}

export type MockEntry = { plan: MockPlan; phone: string; amountCents: number; merchantRequestId: string }

const unavailable = (message: string, details?: unknown) => new AppError(502, 'mpesa_unavailable', message, details)

// Safaricom returns errorMessage on failures and ResponseDescription otherwise.
function darajaMessage(json: any): string | null {
  if (!json || typeof json !== 'object') return null
  const m = json.errorMessage ?? json.ResponseDescription ?? json.ResultDesc ?? null
  return typeof m === 'string' ? m.slice(0, 200) : null
}

export class DarajaClient {
  private token: { value: string; expiresAt: number } | null = null
  // mock mode: what each fake checkout will answer
  readonly mockState = new Map<string, MockEntry>()

  constructor(
    readonly cfg: DarajaConfig,
    private fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private now: () => Date = () => new Date()
  ) {}

  get mode() {
    return this.cfg.mode
  }

  private get baseUrl() {
    if (this.cfg.mode === 'mock') throw new Error('No base URL in mock mode')
    return BASE_URL[this.cfg.mode]
  }

  private async call(path: string, init: RequestInit): Promise<{ status: number; json: any }> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs)
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { ...init, signal: ctrl.signal })
      const text = await res.text()
      let json: any = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      return { status: res.status, json }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw unavailable('M-Pesa did not respond in time. Try again, or take the code from the customer SMS.')
      }
      throw unavailable('Could not reach M-Pesa. Check the internet connection, or take the code from the customer SMS.')
    } finally {
      clearTimeout(timer)
    }
  }

  // OAuth token, cached until a minute before it expires.
  async accessToken(): Promise<string> {
    const nowMs = this.now().getTime()
    if (this.token && this.token.expiresAt - 60_000 > nowMs) return this.token.value
    if (!this.cfg.consumerKey || !this.cfg.consumerSecret) {
      throw unavailable('M-Pesa is not set up yet (missing consumer key or secret).')
    }
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64')
    const { status, json } = await this.call('/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: { authorization: `Basic ${basic}` }
    })
    if (status !== 200 || !json?.access_token) {
      throw unavailable('M-Pesa refused our credentials. Ask the owner to check the M-Pesa settings.')
    }
    const seconds = Number(json.expires_in) || 3599
    this.token = { value: String(json.access_token), expiresAt: nowMs + seconds * 1000 }
    return this.token.value
  }

  buildStkBody(input: StkPushInput, at = this.now()) {
    if (input.amountCents % 100 !== 0) throw new Error('M-Pesa takes whole shillings only')
    const timestamp = darajaTimestamp(at)
    return {
      BusinessShortCode: this.cfg.shortcode,
      Password: stkPassword(this.cfg.shortcode, this.cfg.passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: this.cfg.transactionType,
      Amount: input.amountCents / 100,
      PartyA: input.phone,
      PartyB: this.cfg.partyB || this.cfg.shortcode,
      PhoneNumber: input.phone,
      CallBackURL: callbackUrlFor(this.cfg),
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13)
    }
  }

  async stkPush(input: StkPushInput): Promise<StkPushResult> {
    if (this.cfg.mode === 'mock') {
      const id = randomBytes(6).toString('hex')
      const merchantRequestId = `mock-mr-${id}`
      const checkoutRequestId = `ws_CO_mock_${id}`
      this.mockState.set(checkoutRequestId, {
        plan: mockPlanFor(input.phone),
        phone: input.phone,
        amountCents: input.amountCents,
        merchantRequestId
      })
      return { merchantRequestId, checkoutRequestId, customerMessage: 'Success. Request accepted for processing' }
    }

    const token = await this.accessToken()
    const { status, json } = await this.call('/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildStkBody(input))
    })
    if (status === 401) this.token = null
    if (status !== 200 || String(json?.ResponseCode) !== '0' || !json?.CheckoutRequestID) {
      const why = darajaMessage(json) ?? `HTTP ${status}`
      throw unavailable(`M-Pesa could not send the payment request: ${why}. Try again, or take the code from the customer SMS.`)
    }
    return {
      merchantRequestId: String(json.MerchantRequestID ?? ''),
      checkoutRequestId: String(json.CheckoutRequestID),
      customerMessage: String(json.CustomerMessage ?? '')
    }
  }

  buildQueryBody(checkoutRequestId: string, at = this.now()) {
    const timestamp = darajaTimestamp(at)
    return {
      BusinessShortCode: this.cfg.shortcode,
      Password: stkPassword(this.cfg.shortcode, this.cfg.passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    }
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    if (this.cfg.mode === 'mock') {
      const m = this.mockState.get(checkoutRequestId)
      if (!m || m.plan.outcome === 'never') return { state: 'pending' }
      return { state: 'done', ...mockResult(m) }
    }

    const token = await this.accessToken()
    const { status, json } = await this.call('/mpesa/stkpushquery/v1/query', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildQueryBody(checkoutRequestId))
    })
    if (status === 401) this.token = null
    // "The transaction is being processed"
    if (json?.errorCode === '500.001.1001') return { state: 'pending' }
    if (status === 200 && json && json.ResultCode !== undefined && json.ResultCode !== null) {
      const code = Number(json.ResultCode)
      if (Number.isInteger(code)) return { state: 'done', resultCode: code, resultDesc: String(json.ResultDesc ?? '') }
    }
    const why = darajaMessage(json) ?? `HTTP ${status}`
    throw unavailable(`M-Pesa could not tell us the payment status: ${why}.`)
  }
}

// The result the mock Safaricom gives for one planned checkout.
export function mockResult(m: MockEntry): { resultCode: number; resultDesc: string; receipt?: string; amountCents?: number; phone?: string } {
  switch (m.plan.outcome) {
    case 'success':
      return {
        resultCode: 0,
        resultDesc: 'The service request is processed successfully.',
        receipt: m.plan.receipt,
        amountCents: m.amountCents,
        phone: m.phone
      }
    case 'failed':
      return { resultCode: 1, resultDesc: 'The balance is insufficient for the transaction.' }
    case 'cancelled':
      return { resultCode: 1032, resultDesc: 'Request cancelled by user.' }
    default:
      return { resultCode: 1037, resultDesc: 'DS timeout user cannot be reached.' }
  }
}

export function configFromEnv(): DarajaConfig {
  return {
    mode: env.MPESA_MODE,
    consumerKey: env.MPESA_CONSUMER_KEY,
    consumerSecret: env.MPESA_CONSUMER_SECRET,
    shortcode: env.MPESA_SHORTCODE,
    passkey: env.MPESA_PASSKEY,
    transactionType: env.MPESA_TRANSACTION_TYPE,
    partyB: env.MPESA_PARTY_B,
    callbackUrl: env.MPESA_CALLBACK_URL,
    callbackToken: env.MPESA_CALLBACK_TOKEN,
    timeoutMs: 15_000
  }
}

let client: DarajaClient | null = null

export function getDaraja() {
  if (!client) client = new DarajaClient(configFromEnv())
  return client
}

// Tests swap in a client with a fake fetch. Pass null to go back to the default.
export function setDaraja(c: DarajaClient | null) {
  client = c
}
