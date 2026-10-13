// The Worker of storage-bench.js. `prepare` builds the database of
// fts-data.js in memory and stores it, fresh, after changes all over
// (scattered), and vacuumed after those, both as a snapshot (a Blob in
// IndexedDB, read with FileReaderSync) and as an OPFS file (read with a
// sync access handle). `query` opens one in a new Worker and times the
// searches; `locks` times a shared Web Lock around each of many queries.
import {init} from '@alinea/sqlite-wasm'
import {opfsStorage} from '@alinea/sqlite-wasm/opfs'
import {indexedDBSnapshots} from '@alinea/sqlite-wasm/snapshots'
import {fill, queries, scatter} from './fts-data.js'

const ready = init()
const snapshots = () => indexedDBSnapshots('storage-bench')
// The page cache of databases on a snapshot, for both
const CACHE = 'pragma cache_size = -8192'

let blobReads = 0
const read = FileReaderSync.prototype.readAsArrayBuffer
FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
  blobReads++
  return read.call(this, blob)
}

async function open(store, name) {
  const {Database} = await ready
  const db =
    store === 'snapshot'
      ? (await snapshots().open(Database, {key: name})).db
      : await Database.sync(opfsStorage(`storage-bench-${name}`))
  db.run(CACHE)
  return db
}

const actions = {
  async prepare({rounds}) {
    const {Database} = await ready
    const db = new Database()
    const out = {}
    const store = async name => {
      const [[pages]] = db.exec('pragma page_count')[0].values
      let start = performance.now()
      const session = snapshots().session(db.fork())
      await session.save({key: name, compact: false})
      session.db.close()
      const snapshotMs = performance.now() - start
      start = performance.now()
      const copy = db.fork()
      await opfsStorage(`storage-bench-${name}`).attach(copy)
      copy.close()
      out[name] = {pages, snapshotMs, fileMs: performance.now() - start}
    }
    let start = performance.now()
    fill(db)
    out.fillMs = performance.now() - start
    await store('fresh')
    start = performance.now()
    scatter(db, rounds)
    out.scatterMs = performance.now() - start
    await store('scattered')
    db.run('vacuum')
    await store('vacuumed')
    db.close()
    return out
  },

  async query({store, name}) {
    let start = performance.now()
    blobReads = 0
    const db = await open(store, name)
    db.exec('select count(*) from entries')
    const results = {open: {ms: performance.now() - start, blobReads}}
    for (const round of [1, 2]) {
      let total = 0
      let reads = 0
      for (const [query, run] of queries(db)) {
        blobReads = 0
        start = performance.now()
        run()
        const ms = performance.now() - start
        results[`${query} (${round})`] = {ms, blobReads}
        total += ms
        reads += blobReads
      }
      results[`round ${round}`] = {ms: total, blobReads: reads}
    }
    db.close()
    return results
  },

  // A query of one indexed row, alone and each in a shared Web Lock, as
  // Workers in every tab reading one file would take
  async locks({count = 2000}) {
    const db = await open('file', 'vacuumed')
    const lookup = db.prepare('select title from entries where path = ?')
    const one = i => {
      lookup.bind([`/entries/${1 + (i % 30_000)}`])
      lookup.step()
      lookup.reset()
    }
    for (let i = 0; i < count; i++) one(i)
    let start = performance.now()
    for (let i = 0; i < count; i++) one(i)
    const plain = (performance.now() - start) / count
    start = performance.now()
    for (let i = 0; i < count; i++)
      await navigator.locks.request('storage-bench', {mode: 'shared'}, () => one(i))
    const locked = (performance.now() - start) / count
    lookup.free()
    db.close()
    return {queryMs: plain, inSharedLockMs: locked, lockMs: locked - plain}
  }
}

self.onmessage = async ({data: {id, action, args}}) => {
  try {
    self.postMessage({id, result: await actions[action](args)})
  } catch (error) {
    self.postMessage({id, error: String(error?.stack ?? error)})
  }
}
