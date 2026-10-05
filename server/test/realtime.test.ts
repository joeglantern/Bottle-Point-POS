import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { connectSocket, nextEvent, noEvent, startServer } from './realtime-helpers.js'
import { emitToBranch } from '../src/realtime.js'

let srv: Awaited<ReturnType<typeof startServer>>
let fx: Fixture

beforeAll(async () => {
  await resetDb()
  fx = await seedFixture()
  srv = await startServer()
})
afterAll(async () => {
  await srv.stop()
})

describe('realtime', () => {
  it('refuses a socket without a session', async () => {
    await expect(connectSocket(srv.url, '')).rejects.toThrow('unauthorized')
  })

  it('delivers branch events only to people in that branch', async () => {
    const west = await connectSocket(srv.url, (await Client.login('cashier')).cookie)
    const kili = await connectSocket(srv.url, (await Client.login('kilicashier')).cookie)
    const owner = await connectSocket(srv.url, (await Client.login('owner')).cookie)

    const got = nextEvent(west, 'sale:updated')
    const ownerGot = nextEvent(owner, 'sale:updated')
    const kiliQuiet = noEvent(kili, 'sale:updated')
    emitToBranch(fx.branches.west.id, 'sale:updated', { sale: { id: 'x' } })

    expect((await got).sale.id).toBe('x')
    expect((await ownerGot).sale.id).toBe('x')
    await kiliQuiet
    for (const s of [west, kili, owner]) s.close()
  })
})
