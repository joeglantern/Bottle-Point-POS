import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { io as ioClient, type Socket } from 'socket.io-client'
import { app, ORIGIN } from './helpers.js'
import { closeRealtime, initRealtime } from '../src/realtime.js'

// Boots the real HTTP server plus Socket.IO on a random port.
export async function startServer() {
  const server = await new Promise<Server>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as Server)) as Server
  })
  initRealtime(server)
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    async stop() {
      await closeRealtime()
      await new Promise(r => server.close(r))
    }
  }
}

// Connects a socket as the user who owns `cookie`. Resolves once the server
// has put it in its rooms (the "ready" event).
export function connectSocket(url: string, cookie: string) {
  return new Promise<Socket>((resolve, reject) => {
    const s = ioClient(url, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { cookie, origin: ORIGIN },
      reconnection: false
    })
    s.on('ready', () => resolve(s))
    s.on('connect_error', err => reject(err))
  })
}

// Waits for one event, fails the test if it does not arrive in time.
export function nextEvent<T = any>(s: Socket, event: string, ms = 3000) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms)
    s.once(event, (payload: T) => {
      clearTimeout(t)
      resolve(payload)
    })
  })
}

// Asserts that an event does NOT arrive (used for branch isolation).
export function noEvent(s: Socket, event: string, ms = 600) {
  return new Promise<void>((resolve, reject) => {
    const h = () => reject(new Error(`unexpected ${event}`))
    s.once(event, h)
    setTimeout(() => {
      s.off(event, h)
      resolve()
    }, ms)
  })
}
