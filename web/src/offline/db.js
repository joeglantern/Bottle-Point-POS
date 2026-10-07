// The till's own storage (IndexedDB), so it keeps working without internet.
//
//   kv      cached server answers, the till's key, PIN checks, settings
//   sales   sales made on this till while offline, until the server has them
//   outbox  what still has to be sent, in the order it happened
//   failed  what the server refused for good; kept, shown and downloadable
//
// Everything here survives closing the browser. Only clearing the site's data
// removes it, which is why the till asks Chrome to keep it (persist()).

const NAME = 'bottle-point'
const VERSION = 1
let opening = null

function open() {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      if (!db.objectStoreNames.contains('sales')) db.createObjectStore('sales', { keyPath: 'clientId' })
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true })
      if (!db.objectStoreNames.contains('failed')) db.createObjectStore('failed', { keyPath: 'seq', autoIncrement: true })
    }
    req.onsuccess = () => {
      const db = req.result
      // another tab upgraded the database: let it, and reopen next time
      db.onversionchange = () => { db.close(); opening = null }
      resolve(db)
    }
    req.onerror = () => { opening = null; reject(req.error) }
    req.onblocked = () => console.warn('offline storage is waiting for another tab')
  })
  return opening
}

const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })

// Runs fn(stores) in one transaction, so several writes land together or not at all.
export async function tx(names, mode, fn) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode)
    const stores = Object.fromEntries(names.map(n => [n, t.objectStore(n)]))
    let result
    Promise.resolve(fn(stores)).then(r => { result = r }, err => { try { t.abort() } catch {} ; reject(err) })
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('Offline storage write was cancelled'))
  })
}

export const kvGet = key => tx(['kv'], 'readonly', s => done(s.kv.get(key)))
export const kvSet = (key, value) => tx(['kv'], 'readwrite', s => { s.kv.put(value, key) })
export const kvDel = key => tx(['kv'], 'readwrite', s => { s.kv.delete(key) })

export const getAll = name => tx([name], 'readonly', s => done(s[name].getAll()))
export const getOne = (name, key) => tx([name], 'readonly', s => done(s[name].get(key)))
export const count = name => tx([name], 'readonly', s => done(s[name].count()))
export { done }

// Ask Chrome not to clear the till's storage when the disk is low.
export async function keepStorage() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {}
}

export const supported = () => typeof indexedDB !== 'undefined'
