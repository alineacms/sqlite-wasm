// The Worker of compact-bench.js: builds a database of about 110 MB,
// scatters its pages with many saves of changes all over (deltas, and
// every few a full save in place, as 0.8.2 wrote them), then saves it in
// full in place and compacted, timing each and the longest the Worker was
// busy without a break; or opens a saved snapshot and times reading it.
import {init} from '@alinea/sqlite-wasm'
import {indexedDBSnapshots, opfsSnapshots} from '@alinea/sqlite-wasm/snapshots'

const ready = init()
const storages = {indexeddb: indexedDBSnapshots, opfs: opfsSnapshots}
const ROWS = 100_000

let blobReads = 0
const read = FileReaderSync.prototype.readAsArrayBuffer
FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
  blobReads++
  return read.call(this, blob)
}

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// The longest stretch without a timer firing while `run` runs: what other
// messages would wait
async function timed(run) {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  const start = performance.now()
  try {
    const result = await run()
    return {ms: performance.now() - start, longestBusyMs: longest, result}
  } finally {
    clearInterval(timer)
  }
}

const actions = {
  async build({variant, rounds, readCache}) {
    const {Database} = await ready
    const storage = storages[variant]('compact-bench', {maxDepth: 8})
    const session = await storage.open(Database)
    const db = session.db
    db.run(`
      create table items (id integer primary key, path text not null, body text not null);
      create index items_path on items (path);
    `)
    db.run('begin')
    const insert = db.prepare('insert into items values (?, ?, ?)')
    for (let id = 0; id < ROWS; id++)
      insert.run([id, `/items/${id}`, `${id} `.padEnd(1000, 'x')])
    insert.free()
    db.run('commit')
    await session.save({key: 'v0', compact: false})
    // Syncs: changes all over, each saved, in place as before
    const next = random(1)
    for (let round = 1; round <= rounds; round++) {
      db.run('begin')
      for (let i = 0; i < 100; i++) {
        const id = Math.floor(next() * ROWS * 1.1)
        if (next() < 0.2) db.run('delete from items where id = ?', [id])
        else
          db.run('insert or replace into items values (?, ?, ?)', [
            id,
            `/items/${id}`,
            `${id} ${round} `.padEnd(600 + Math.floor(next() * 1200), 'y')
          ])
      }
      db.run('commit')
      await session.save({key: `r${round}`, compact: false})
    }
    const full = storages[variant]('compact-bench', {maxDepth: 0, readCache})
    const results = {}
    for (const [key, compact] of [['inplace', false], ['compacted', true]]) {
      const own = full.session(db.fork())
      // The save reads the snapshot it lies over: read it first, as both do.
      own.db.exec('select count(*) from items')
      results[key] = await timed(() => own.save({key, compact}))
      results[key].size = own.snapshot.size
      results[key].result = undefined
      own.db.close()
    }
    db.close()
    return results
  },

  async scan({variant, key}) {
    const {Database} = await ready
    const storage = storages[variant]('compact-bench')
    const db = (await storage.open(Database, {key})).db
    const time = (name, sql) => {
      blobReads = 0
      const start = performance.now()
      db.exec(sql)
      return {[name]: {ms: performance.now() - start, blobReads}}
    }
    const out = {
      ...time('table scan', 'select sum(length(body)) from items'),
      ...time('index range', "select count(*), sum(length(body)) from items where path between '/items/2' and '/items/3'")
    }
    db.close()
    return out
  }
}

self.onmessage = async ({data: {id, action, args}}) => {
  try {
    self.postMessage({id, result: await actions[action](args)})
  } catch (error) {
    self.postMessage({id, error: String(error?.stack ?? error)})
  }
}
