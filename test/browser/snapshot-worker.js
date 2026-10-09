// A SharedWorker or dedicated Worker the browser tests and benchmarks drive,
// holding a database in snapshot storage, with bases in OPFS or IndexedDB:
// each message names an action, and is answered with its result or error.
// Give every SharedWorker its own name to start a new one.
import {init} from '@alinea/sqlite-wasm'
import {indexedDBSnapshots, opfsSnapshots} from '@alinea/sqlite-wasm/snapshots'
import {build, change, INDEX_COUNT, QUERIES} from './bench-data.js'

const ready = init()
let storage
let session
let db

const rows = sql => db.exec(sql)[0]?.values ?? []
const storages = {opfs: opfsSnapshots, indexeddb: indexedDBSnapshots}

// How much the Wasm heap grows while `run` runs (sampled), and its size.
// Workers have no measure of the JS heap (performance.memory is the main
// thread's, and only Chromium's).
async function measured(run) {
  const wasmHeap = () => db.wasm.HEAPU8.byteLength
  const before = wasmHeap()
  let peak = before
  const sample = () => (peak = Math.max(peak, wasmHeap()))
  const timer = setInterval(sample, 2)
  const start = performance.now()
  try {
    const result = await run()
    const ms = performance.now() - start
    sample()
    return {result, ms, wasmHeap: peak, wasmGrowth: peak - before}
  } finally {
    clearInterval(timer)
  }
}

const time = run => {
  const start = performance.now()
  const result = run()
  return {ms: performance.now() - start, result}
}

const actions = {
  supported: ({variant = 'opfs'}) => storages[variant]('probe').supported(),
  // Open a database, and with `query`, time it to the first query of the
  // benchmark database.
  async open({variant = 'opfs', storage: name, base, pageSize, query}) {
    const {Database} = await ready
    storage = storages[variant](name)
    const start = performance.now()
    session = await storage.open(Database, base === undefined ? {} : {key: base})
    db = session.db
    const openMs = performance.now() - start
    if (query) rows(QUERIES.point[0])
    if (pageSize) db.run(`pragma page_size = ${pageSize}`)
    return {base: db.base?.key ?? null, openMs, ms: performance.now() - start}
  },
  run({sql, params}) {
    db.run(sql, params)
  },
  rows: ({sql}) => rows(sql),
  fill({count, size, from = 0}) {
    db.run('create table if not exists items (id integer primary key, body text, n integer)')
    db.run('begin')
    const insert = db.prepare('insert into items (id, body, n) values (?, ?, 0)')
    for (let i = from; i < from + count; i++) insert.run([i, `${i} `.padEnd(size, 'x')])
    insert.free()
    db.run('commit')
  },
  async checkpoint({name}) {
    const start = performance.now()
    const {status} = await session.save({key: name})
    return {written: status === 'written', status, ms: performance.now() - start}
  },
  cleanup: () => storage.retain(),
  // Delete snapshot `key`, as cleanup in a Worker without locks would
  remove: ({key}) => storage.store.remove(key),
  list: () => storage.list(),
  // Read every row of the base, and change some, `rounds` times with a
  // pause in between, checking each time that what was read adds up.
  async churn({rounds}) {
    let expected = rows('select sum(n) from items')[0][0]
    const [[count, length]] = rows('select count(*), sum(length(body)) from items')
    for (let round = 0; round < rounds; round++) {
      const id = (round * 7919) % count
      db.run('update items set n = n + 1 where id = ?', [id])
      expected++
      const [[n, c, l]] = rows('select sum(n), count(*), sum(length(body)) from items')
      if (n !== expected || c !== count || l !== length)
        throw new Error(`round ${round}: read ${[n, c, l]}, expected ${[expected, count, length]}`)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    return expected
  },
  base: () => db.base?.key ?? null,
  close() {
    db.close()
  },

  // Benchmarks, on the content database of bench-data.js

  // Build the database in memory, then write it as the first base.
  async benchFirstBase({variant, storage: name, key}) {
    const {Database} = await ready
    storage = storages[variant](name)
    session = await storage.open(Database, {branch: 'bench'})
    db = session.db
    build(db)
    const [[pages]] = rows('pragma page_count')
    const held = Number(rows('pragma overlay_pages')[0][0]) * 65536
    const {ms, wasmHeap, wasmGrowth} = await measured(() =>
      session.save({key})
    )
    return {ms, size: pages * 65536, held, wasmHeap, wasmGrowth}
  },
  // Each query on a fresh fork (empty page cache), then again on it; with
  // `cacheKiB`, with that page cache instead of the default.
  benchQueries({cacheKiB} = {}) {
    const out = {}
    for (const [name, [sql]] of Object.entries(QUERIES)) {
      const fork = db.fork()
      try {
        if (cacheKiB) fork.run(`pragma cache_size = -${cacheKiB}`)
        const cold = time(() => fork.exec(sql))
        const warm = time(() => fork.exec(sql))
        out[name] = {cold: cold.ms, warm: warm.ms}
      } finally {
        fork.close()
      }
    }
    return out
  },
  // Change `count` rows, then checkpoint them.
  async benchCheckpoint({count, version, key}) {
    change(db, count, version)
    const held = Number(rows('pragma overlay_pages')[0][0]) * 65536
    const {ms, result, wasmHeap, wasmGrowth} = await measured(() =>
      session.save({key})
    )
    return {ms, written: result.status === 'written', held, wasmHeap, wasmGrowth}
  },
  // Write and checkpoint in a loop for `seconds`, cleaning up after each.
  async writerLoop({seconds}) {
    db.run('create table if not exists log (i integer primary key)')
    const end = performance.now() + seconds * 1000
    let i = 0
    while (performance.now() < end) {
      i++
      change(db, 100, i)
      db.run('insert into log values (?)', [i])
      const {status} = await session.save({key: `writer-${i}`})
      if (status !== 'written') throw new Error(`save ${i} ${status}`)
      await storage.retain()
    }
    const [[count, max]] = rows('select count(*), max(i) from log')
    if (count !== i || max !== i) throw new Error(`log: ${count} ${max}, expected ${i}`)
    return {checkpoints: i, base: db.base.key}
  },
  // Read and write this overlay in a loop for `seconds`, checking reads.
  async readerLoop({seconds}) {
    db.run('create table if not exists counter (n integer)')
    db.run('insert into counter values (0)')
    const [[entries]] = rows('select count(*) from entries')
    const end = performance.now() + seconds * 1000
    let n = 0
    let reads = 0
    while (performance.now() < end) {
      const id = (n * 7919) % entries
      const [[data]] = rows(`select data from entries where id = ${id}`)
      if (JSON.parse(data).version !== 0) throw new Error(`row ${id} changed`)
      const [[count]] = rows(INDEX_COUNT)
      if (count !== 1160) throw new Error(`range: ${count}`)
      reads += 2
      db.run('update counter set n = n + 1')
      db.run('update entries set status = ? where id = ?', [`seen ${n}`, id])
      n++
      if (rows('select n from counter')[0][0] !== n) throw new Error('counter')
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    if (rows('select count(*) from entries')[0][0] !== entries) throw new Error('entries')
    if (rows("select count(*) from entries where status like 'seen %'")[0][0] < Math.min(n, entries) * 0.5)
      throw new Error('writes lost')
    return {rounds: n, reads, base: db.base.key}
  },
  // Delete the stored base this database reads (as cleanup would without
  // locks), then read every page of it from a fresh fork.
  async benchDeletedRead() {
    await storage.store.remove(db.base.key, {force: true})
    const fork = db.fork()
    try {
      const [[count, length]] = fork.exec(QUERIES.full[0])[0].values
      return {ok: count === 20_000, count, length}
    } finally {
      fork.close()
    }
  },
  // Open, change, checkpoint and reopen a small database.
  async support({variant, storage: name}) {
    const {Database} = await ready
    const s = storages[variant](name)
    if (!s.supported()) return {ok: false, error: 'supported() is false'}
    const first = await s.open(Database)
    first.db.exec('create table t (x); insert into t values (1), (2)')
    await first.save({key: 'a'})
    first.db.run('insert into t values (3)')
    await first.save({key: 'b'})
    const second = await s.open(Database)
    const [[sum]] = second.db.exec('select sum(x) from t')[0].values
    await first.close()
    await second.close()
    return sum === 6 ? {ok: true} : {ok: false, error: `read ${sum}`}
  }
}

async function answer(post, {id, action, args}) {
  try {
    post({id, result: await actions[action](args ?? {})})
  } catch (error) {
    post({id, error: {message: String(error?.message ?? error), code: error?.code}})
  }
}

if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) {
  self.onconnect = ({ports: [port]}) => {
    port.onmessage = ({data}) => answer(message => port.postMessage(message), data)
    port.postMessage({ready: true})
  }
} else {
  self.onmessage = ({data}) => answer(message => self.postMessage(message), data)
  self.postMessage({ready: true})
}
