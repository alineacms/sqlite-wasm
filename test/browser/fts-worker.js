// The Worker of fts-bench.js: builds the database of fts-data.js and saves
// it as a snapshot in IndexedDB, or opens that snapshot and times
// full-text searches and indexed lookups on it, as alinea's dashboard
// searches its cache. Counts the Blob reads (FileReaderSync) each query
// makes.
import {init} from '@alinea/sqlite-wasm'
import {indexedDBSnapshots} from '@alinea/sqlite-wasm/snapshots'
import {fill, queries, ROWS} from './fts-data.js'

const ready = init()
const STORAGE = 'fts-bench'

let blobReads = 0
const read = FileReaderSync.prototype.readAsArrayBuffer
FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
  blobReads++
  return read.call(this, blob)
}

const actions = {
  async build() {
    const {Database} = await ready
    const storage = indexedDBSnapshots(STORAGE)
    const session = await storage.open(Database)
    const db = session.db
    fill(db)
    const start = performance.now()
    await session.save({key: 'base'})
    const saveMs = performance.now() - start
    const [[pages, pageSize]] = db.exec(
      'select page_count, page_size from pragma_page_count, pragma_page_size'
    )[0].values
    db.close()
    return {rows: ROWS, bytes: pages * pageSize, pageSize, saveMs}
  },

  async query({readCache} = {}) {
    const {Database} = await ready
    const storage = indexedDBSnapshots(STORAGE, {readCache})
    let start = performance.now()
    blobReads = 0
    const session = await storage.open(Database, {key: 'base'})
    const db = session.db
    const results = {open: {ms: performance.now() - start, blobReads}}
    const time = (name, run) => {
      blobReads = 0
      const start = performance.now()
      const rows = run()
      results[name] = {ms: performance.now() - start, blobReads, rows}
    }
    // Twice: the second round reads again what left SQLite's page cache
    for (const round of [1, 2]) {
      let total = 0
      let reads = 0
      for (const [name, run] of queries(db)) {
        time(`${name} (${round})`, run)
        total += results[`${name} (${round})`].ms
        reads += results[`${name} (${round})`].blobReads
      }
      results[`round ${round}`] = {ms: total, blobReads: reads}
    }
    db.close()
    return results
  }
}

self.onmessage = async ({data: {id, action, args}}) => {
  try {
    self.postMessage({id, result: await actions[action](args)})
  } catch (error) {
    self.postMessage({id, error: String(error?.stack ?? error)})
  }
}
