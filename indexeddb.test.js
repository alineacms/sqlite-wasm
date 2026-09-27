import 'fake-indexeddb/auto'
import {afterEach, beforeAll, describe, expect, test} from 'bun:test'
import {init} from '@alinea/sqlite-wasm'
import {indexedDBStorage} from '@alinea/sqlite-wasm/indexeddb'

// Exercise the published artifacts, not the TypeScript source. Build first.
let Database
let names = 0
const open = []

beforeAll(async () => {
  ;({Database} = await init())
})

afterEach(async () => {
  for (const db of open.splice(0)) {
    try {
      db.close()
    } catch {}
  }
})

function uniqueName() {
  return `test-${++names}-${Math.random().toString(36).slice(2)}`
}

async function syncDb(name) {
  const db = await Database.sync(indexedDBStorage(name))
  open.push(db)
  return db
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Reads the database file as it is stored in IndexedDB right now.
async function stored(name) {
  const idb = await request(indexedDB.open(name))
  try {
    const tx = idb.transaction(['chunks', 'meta'])
    const meta = await request(tx.objectStore('meta').get('database'))
    const keys = await request(tx.objectStore('chunks').getAllKeys())
    const values = await request(tx.objectStore('chunks').getAll())
    const image = new Uint8Array(meta.size)
    keys.forEach((key, i) => {
      const offset = key * meta.chunkSize
      image.set(values[i].subarray(0, meta.size - offset), offset)
    })
    return {meta, image, keys}
  } finally {
    idb.close()
  }
}

function query(db, sql) {
  return db.exec(sql)[0]?.values
}

describe('IndexedDB storage', () => {
  test('stores commits and restores them when reopened', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table notes (text)')
    db.run('insert into notes values (?)', ['stored ✓'])
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
    db.close()

    const reopened = await syncDb(name)
    expect(query(reopened, 'select text from notes')).toEqual([['stored ✓']])
  })

  test('writes remaining commits on close before reopening', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table notes (text)')
    for (let i = 0; i < 50; i++) db.run('insert into notes values (?)', [i])
    const expected = db.export()
    db.close()

    const reopened = await syncDb(name)
    expect(query(reopened, 'select count(*) from notes')).toEqual([[50]])
    expect(reopened.export()).toEqual(expected)
  })

  test('only stores committed states', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table payloads (value blob)')
    db.run("insert into payloads values ('committed')")
    await db.flush()
    const committed = db.export()

    db.run('begin')
    // Larger than the page cache, so SQLite writes pages mid-transaction.
    db.run(`
      with recursive seq(i) as (select 1 union all select i + 1 from seq where i < 2000)
      insert into payloads select randomblob(1000) from seq
    `)
    await db.flush()
    expect((await stored(name)).image).toEqual(committed)
    db.run('rollback')
    await db.flush()
    expect((await stored(name)).image).toEqual(committed)

    db.run('begin')
    db.run('insert into payloads values (randomblob(100000))')
    db.run('commit')
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('removes chunks when the database shrinks', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table payloads (value blob)')
    db.run('insert into payloads values (zeroblob(1000000))')
    await db.flush()
    const before = await stored(name)

    db.run('delete from payloads')
    db.run('vacuum')
    db.run("insert into payloads values ('after vacuum')")
    await db.flush()
    const after = await stored(name)
    expect(after.image).toEqual(db.export())
    expect(after.keys.length).toBeLessThan(before.keys.length)
    expect(Math.max(...after.keys)).toBeLessThan(
      after.meta.size / after.meta.chunkSize
    )
  })

  test('coalesces commits made in a row', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table payloads (value blob)')
    await db.flush()
    // Grow, shrink and grow again before anything is written.
    db.run('insert into payloads values (zeroblob(500000))')
    db.run('delete from payloads')
    db.run('vacuum')
    for (let i = 0; i < 100; i++)
      db.run('insert into payloads values (?)', [`row ${i}`])

    const transaction = IDBDatabase.prototype.transaction
    let writes = 0
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (mode === 'readwrite') writes++
      return transaction.call(this, stores, mode, options)
    }
    try {
      await db.flush()
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
    expect(writes).toBe(1)
    expect((await stored(name)).image).toEqual(db.export())
  })

  test.each([1024, 65536])(
    'stores databases with %i byte pages',
    async pageSize => {
      const name = uniqueName()
      const db = await syncDb(name)
      db.run(`pragma page_size = ${pageSize}`)
      db.run('create table items (value blob)')
      db.run('insert into items values (randomblob(300000))')
      await db.flush()
      const {meta, image} = await stored(name)
      expect(meta.chunkSize).toBe(pageSize)
      expect(image).toEqual(db.export())
      db.close()

      const reopened = await syncDb(name)
      expect(query(reopened, 'pragma page_size')).toEqual([[pageSize]])
      expect(reopened.export()).toEqual(image)
    }
  )

  test('keeps its chunks after VACUUM changes the page size', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table items (value text)')
    db.run("insert into items values ('kept')")
    db.run('pragma page_size = 16384')
    db.run('vacuum')
    expect(query(db, 'pragma page_size')).toEqual([[16384]])
    db.close()

    const reopened = await syncDb(name)
    expect(query(reopened, 'pragma page_size')).toEqual([[16384]])
    reopened.run("insert into items values ('added')")
    await reopened.flush()
    const {meta, image} = await stored(name)
    expect(meta.chunkSize).toBe(4096)
    expect(image).toEqual(reopened.export())
    reopened.close()

    const again = await syncDb(name)
    expect(query(again, 'select value from items order by rowid')).toEqual([
      ['kept'],
      ['added']
    ])
  })

  test('reports failed writes and retries them', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table notes (text)')
    await db.flush()

    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (mode === 'readwrite') throw new Error('Quota exceeded')
      return transaction.call(this, stores, mode, options)
    }
    try {
      db.run("insert into notes values ('first')")
      await expect(db.flush()).rejects.toThrow('Quota exceeded')
      db.run("insert into notes values ('second')")
      await expect(db.flush()).rejects.toThrow('Quota exceeded')
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('never stores part of a batch', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table payloads (value blob)')
    await db.flush()
    const committed = db.export()

    const put = IDBObjectStore.prototype.put
    let puts = 0
    IDBObjectStore.prototype.put = function (...args) {
      if (++puts === 3) throw new Error('Put failed')
      return put.apply(this, args)
    }
    try {
      db.run('insert into payloads values (randomblob(50000))')
      await expect(db.flush()).rejects.toThrow('Put failed')
    } finally {
      IDBObjectStore.prototype.put = put
    }
    expect((await stored(name)).image).toEqual(committed)
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('reports the final write error after closing', async () => {
    const name = uniqueName()
    const db = await Database.sync(indexedDBStorage(name))
    db.run('create table notes (text)')
    await db.flush()

    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (mode === 'readwrite') throw new Error('Quota exceeded')
      return transaction.call(this, stores, mode, options)
    }
    try {
      db.run("insert into notes values ('lost')")
      db.close()
      await expect(db.flush()).rejects.toThrow('Quota exceeded')
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
    // Not retried on the closed connection
    await expect(db.flush()).rejects.toThrow('Quota exceeded')
  })

  test('loads databases larger than one read', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table payloads (value blob)')
    db.run(`
      with recursive seq(i) as (select 1 union all select i + 1 from seq where i < 12)
      insert into payloads select randomblob(1000000) from seq
    `)
    const expected = db.export()
    db.close()

    const reopened = await syncDb(name)
    expect(reopened.export()).toEqual(expected)
  })

  test('does not store forks', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    db.run('create table notes (text)')
    db.run("insert into notes values ('source')")
    await db.flush()
    const expected = db.export()
    const fork = db.fork()
    try {
      fork.run("insert into notes values ('fork')")
      await fork.flush()
      await db.flush()
      expect((await stored(name)).image).toEqual(expected)
    } finally {
      fork.close()
    }
  })

  test('deletes stored databases after their last commits are written', async () => {
    const name = uniqueName()
    const storage = indexedDBStorage(name)
    const db = await Database.sync(storage)
    db.run('create table notes (text)')
    db.close()
    await storage.delete()
    expect((await indexedDB.databases()).map(info => info.name))
      .not.toContain(name)

    const fresh = await syncDb(name)
    expect(query(fresh, 'select count(*) from sqlite_schema')).toEqual([[0]])
  })

  test('reports commits again after a commit listener throws', () => {
    const db = new Database()
    try {
      const commits = []
      db.onCommit(commit => {
        if (commits.push(commit) === 1) throw new Error('Listener failed')
      })
      db.run('create table first (value)')
      db.run('create table second (value)')
      expect(query(db, 'select count(*) from sqlite_schema')).toEqual([[2]])
      expect(commits).toHaveLength(2)
      const [failed, next] = commits
      for (const index of failed.chunks.keys())
        expect(next.chunks.has(index)).toBe(true)
    } finally {
      db.close()
    }
  })

  test('resolves flush right away for in-memory databases', async () => {
    const db = new Database()
    try {
      await db.flush()
    } finally {
      db.close()
    }
  })
})
