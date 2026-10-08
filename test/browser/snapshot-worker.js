// A SharedWorker the browser tests drive, holding a database in snapshot
// storage: each message names an action, and is answered with its result
// or error. Give every instance its own name to start a new one.
import {init} from '@alinea/sqlite-wasm'
import {snapshotStorage} from '@alinea/sqlite-wasm/snapshots'

const ready = init()
let storage
let db

const rows = sql => db.exec(sql)[0]?.values ?? []

const actions = {
  supported: () => snapshotStorage('probe').supported(),
  async open({storage: name, base, pageSize}) {
    const {Database} = await ready
    storage = snapshotStorage(name)
    db = await storage.open(Database, base)
    if (pageSize) db.run(`pragma page_size = ${pageSize}`)
    return db.base?.name ?? null
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
    const written = await storage.checkpoint(db, name)
    return {written, ms: performance.now() - start}
  },
  cleanup: () => storage.cleanup(),
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
  // Time reading every page of the base once, from a fresh fork (whose
  // page cache is empty).
  scan() {
    const fork = db.fork()
    try {
      const start = performance.now()
      const [[bytes]] = fork.exec('select sum(length(body)) from items')[0].values
      const ms = performance.now() - start
      const [[pageSize]] = fork.exec('pragma page_size')[0].values
      const [[pages]] = fork.exec('pragma page_count')[0].values
      return {ms, bytes, pageSize, pages}
    } finally {
      fork.close()
    }
  },
  // Time reading every page of the base file with FileReaderSync alone.
  async rawScan({pageSize}) {
    const file = db.base.source
    const reader = new FileReaderSync()
    const start = performance.now()
    let reads = 0
    for (let at = 0; at < file.size; at += pageSize, reads++) {
      reader.readAsArrayBuffer(file.slice(at, at + pageSize))
    }
    return {ms: performance.now() - start, reads}
  },
  base: () => db.base?.name ?? null,
  close() {
    db.close()
  }
}

self.onconnect = ({ports: [port]}) => {
  port.onmessage = async ({data: {id, action, args}}) => {
    try {
      port.postMessage({id, result: await actions[action](args ?? {})})
    } catch (error) {
      port.postMessage({id, error: {message: error.message, code: error.code}})
    }
  }
  port.postMessage({ready: true})
}
