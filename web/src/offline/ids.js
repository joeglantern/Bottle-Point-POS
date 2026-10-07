import { kvGet, kvSet } from './db.js'

// Sales made on this till offline, and the server id each one got once synced.

export async function serverIdFor(clientId) {
  return ((await kvGet('synced')) ?? {})[clientId] ?? null
}

export async function rememberServerId(clientId, sale) {
  const map = (await kvGet('synced')) ?? {}
  map[clientId] = sale
  // keep the last 500; older ones are long since done
  const keys = Object.keys(map)
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete map[k]
  await kvSet('synced', map)
}
