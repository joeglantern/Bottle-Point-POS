import { done, getAll, tx } from './db.js'

// What this till still has to send, oldest first. A sale made offline has one
// entry, replaced with its latest state each time it changes (a new opId each
// time, so the server always applies the newest state and never an old one twice).

const changed = () => window.dispatchEvent(new Event('bp:outbox'))

export async function queue(kind, key, op) {
  await tx(['outbox'], 'readwrite', async s => {
    if (key) {
      const rows = await done(s.outbox.getAll())
      const had = rows.find(r => r.key === key)
      if (had) {
        s.outbox.put({ ...had, op, at: Date.now() })
        return
      }
    }
    s.outbox.add({ kind, key: key ?? null, op, at: Date.now() })
  })
  changed()
}

// Drops a queued item (a local tab emptied before it was ever sent).
export async function unqueue(key) {
  await tx(['outbox'], 'readwrite', async s => {
    const rows = await done(s.outbox.getAll())
    for (const r of rows) if (r.key === key) s.outbox.delete(r.seq)
  })
  changed()
}

export const pending = () => getAll('outbox')
export const failedItems = () => getAll('failed')

// Removes a sent item, but only if it was not replaced by a newer state meanwhile.
export async function sent(opId) {
  await tx(['outbox'], 'readwrite', async s => {
    const rows = await done(s.outbox.getAll())
    for (const r of rows) if (r.op.opId === opId) s.outbox.delete(r.seq)
  })
  changed()
}

// The server refused it for good: keep it where people can see and download it.
export async function refused(opId, message) {
  await tx(['outbox', 'failed'], 'readwrite', async s => {
    const rows = await done(s.outbox.getAll())
    for (const r of rows) {
      if (r.op.opId !== opId) continue
      const { seq, ...rest } = r
      s.failed.add({ ...rest, message, refusedAt: Date.now() })
      s.outbox.delete(seq)
    }
  })
  changed()
}

// Everything not yet on the server, as a file a manager can keep.
export async function exportUnsent() {
  const [outbox, failed] = await Promise.all([pending(), failedItems()])
  return { exportedAt: new Date().toISOString(), waiting: outbox.map(r => r.op), refused: failed.map(r => ({ message: r.message, op: r.op })) }
}

// Puts a refused item back in the queue (after the cause was fixed).
export async function retryRefused(seq) {
  await tx(['outbox', 'failed'], 'readwrite', async s => {
    const r = await done(s.failed.get(seq))
    if (!r) return
    s.failed.delete(seq)
    s.outbox.add({ kind: r.kind, key: r.key, op: { ...r.op, opId: crypto.randomUUID() }, at: Date.now() })
  })
  changed()
}
