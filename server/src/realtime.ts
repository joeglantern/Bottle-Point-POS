import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { actorFromHeaders, type Actor } from './middleware/auth.js'
import { isTrustedOrigin } from './lib/tenant.js'

// Event names the web app listens for. Payloads are always the full updated
// object (not a diff) so a client can simply replace what it has.
export const Events = {
  saleUpdated: 'sale:updated', // { sale }
  mpesaUpdated: 'mpesa:updated', // { request }
  approvalUpdated: 'approval:updated', // { approval }
  stockUpdated: 'stock:updated', // { branchId, productId, qty }
  shiftUpdated: 'shift:updated', // { shift }
  productUpdated: 'product:updated' // { product }
} as const

let io: Server | null = null

const branchRoom = (id: string) => `branch:${id}`
const businessRoom = (id: string) => `business:${id}`

export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: (origin, cb) => cb(null, !origin || isTrustedOrigin(origin)), credentials: true },
    serveClient: false
  })

  // Same session cookie as the HTTP API. No session, no socket.
  io.use(async (socket, next) => {
    try {
      const headers = new Headers()
      for (const [k, v] of Object.entries(socket.handshake.headers)) {
        if (typeof v === 'string') headers.set(k, v)
        else if (Array.isArray(v)) headers.set(k, v.join(', '))
      }
      const actor = await actorFromHeaders(headers)
      if (!actor) return next(new Error('unauthorized'))
      socket.data.actor = actor
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', socket => {
    const actor = socket.data.actor as Actor
    socket.join(businessRoom(actor.businessId))
    for (const b of actor.branchIds) socket.join(branchRoom(b))
    socket.emit('ready', { userId: actor.id, branchIds: actor.branchIds })
  })

  return io
}

export function emitToBranch(branchId: string, event: string, payload: unknown) {
  io?.to(branchRoom(branchId)).emit(event, payload)
}

export function emitToBusiness(businessId: string, event: string, payload: unknown) {
  io?.to(businessRoom(businessId)).emit(event, payload)
}

export async function closeRealtime() {
  if (io) await io.close()
  io = null
}
