import 'fake-indexeddb/auto'
import {IDBFactory, IDBKeyRange as FakeKeyRange} from 'fake-indexeddb'
import {afterEach, beforeAll, describe, expect, test} from 'bun:test'
import {SQLiteError, init} from '@alinea/sqlite-wasm'
import {
  CorruptDatabaseError,
  indexedDBStorage
} from '@alinea/sqlite-wasm/indexeddb'

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
async function stored(name, factory = indexedDB) {
  const idb = await request(factory.open(name))
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

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
}

// Replaces what is stored under name with a meta record and chunks. An
// undefined meta leaves the meta record out.
async function storeRaw(name, meta, chunks) {
  const req = indexedDB.open(name, 1)
  req.onupgradeneeded = () => {
    req.result.createObjectStore('chunks')
    req.result.createObjectStore('meta')
  }
  const idb = await request(req)
  try {
    const tx = idb.transaction(['chunks', 'meta'], 'readwrite')
    tx.objectStore('chunks').clear()
    tx.objectStore('meta').clear()
    for (const [index, chunk] of chunks)
      tx.objectStore('chunks').put(chunk, index)
    if (meta !== undefined) tx.objectStore('meta').put(meta, 'database')
    await transactionDone(tx)
  } finally {
    idb.close()
  }
}

// Counts the IndexedDB write transactions started while run is awaited.
async function countWrites(run) {
  const transaction = IDBDatabase.prototype.transaction
  let writes = 0
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    if (mode === 'readwrite') writes++
    return transaction.call(this, stores, mode, options)
  }
  try {
    await run()
  } finally {
    IDBDatabase.prototype.transaction = transaction
  }
  return writes
}

async function notesDb(name, rows) {
  const db = await syncDb(name)
  db.run('create table notes (text)')
  for (const row of rows) db.run('insert into notes values (?)', [row])
  return db
}

function inMemory() {
  const db = new Database()
  open.push(db)
  return db
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

describe('Attaching a database to storage', () => {
  async function attached(name, db) {
    open.push(db)
    await db.attach(indexedDBStorage(name))
    return db
  }

  test('stores a fork and keeps storing it', async () => {
    const source = await notesDb(uniqueName(), ['a', 'b'])
    const name = uniqueName()
    const db = await attached(name, source.fork())
    await db.flush()
    expect((await stored(name)).image).toEqual(source.export())

    // Independent of the source, which keeps its own storage.
    db.run("insert into notes values ('attached')")
    source.run("insert into notes values ('source')")
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
    db.close()

    const reopened = await syncDb(name)
    expect(query(reopened, 'select text from notes')).toEqual([
      ['a'],
      ['b'],
      ['attached']
    ])
  })

  test('replaces everything the storage held', async () => {
    const name = uniqueName()
    const old = await syncDb(name)
    old.run('create table payloads (value blob)')
    old.run('insert into payloads values (randomblob(500000))')
    old.detach()

    const db = await attached(name, inMemory())
    db.run('create table notes (text)')
    db.run("insert into notes values ('new')")
    await db.flush()
    const {image, keys, meta} = await stored(name)
    expect(image).toEqual(db.export())
    expect(Math.max(...keys)).toBeLessThan(meta.size / meta.chunkSize)
  })

  test('stores an empty database as an empty database', async () => {
    const name = uniqueName()
    const old = await notesDb(name, ['old'])
    old.detach()
    const db = await attached(name, new Database())
    await db.flush()
    db.close()
    const reopened = await syncDb(name)
    expect(query(reopened, 'select count(*) from sqlite_schema')).toEqual([[0]])
  })

  test('writes the replacement in one transaction, or not at all', async () => {
    const name = uniqueName()
    const old = await syncDb(name)
    old.run('create table payloads (value blob)')
    old.run('insert into payloads values (randomblob(20000))')
    old.detach()
    await old.flush()
    const before = await stored(name)

    const source = inMemory()
    source.run('create table payloads (value blob)')
    source.run('insert into payloads values (randomblob(200000))')
    const put = IDBObjectStore.prototype.put
    let puts = 0
    IDBObjectStore.prototype.put = function (...args) {
      if (++puts >= 10) throw new Error('Put failed')
      return put.apply(this, args)
    }
    try {
      await source.attach(indexedDBStorage(name))
      await expect(source.flush()).rejects.toThrow('Put failed')
    } finally {
      IDBObjectStore.prototype.put = put
    }
    expect(await stored(name)).toEqual(before)
    await source.flush()
    expect((await stored(name)).image).toEqual(source.export())
  })

  test('stores the committed state when storing starts', async () => {
    const name = uniqueName()
    const db = inMemory()
    db.run('create table notes (text)')
    const attaching = db.attach(indexedDBStorage(name))
    // Committed while the storage opens: part of the stored state.
    db.run("insert into notes values ('while opening')")
    await attaching
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('fails during a write transaction, leaving the name free', async () => {
    const name = uniqueName()
    const db = inMemory()
    db.run('create table notes (text)')
    db.run('begin')
    db.run("insert into notes values ('uncommitted')")
    const error = await db.attach(indexedDBStorage(name)).catch(e => e)
    expect(error).toBeInstanceOf(SQLiteError)
    expect(error.code).toBe('SQLITE_BUSY')
    db.run('commit')
    expect(db.persistence).toBeUndefined()
    await db.attach(indexedDBStorage(name))
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('fails for a database that is stored already', async () => {
    const db = await notesDb(uniqueName(), [])
    const error = await db.attach(indexedDBStorage(uniqueName())).catch(e => e)
    expect(error.code).toBe('SQLITE_MISUSE')
  })

  test('moves a detached database to another name', async () => {
    const first = uniqueName()
    const second = uniqueName()
    const db = await notesDb(first, ['first'])
    db.detach()
    await db.attach(indexedDBStorage(second))
    db.run("insert into notes values ('second')")
    await db.flush()
    expect(query(await syncDb(first), 'select text from notes')).toEqual([
      ['first']
    ])
    expect((await stored(second)).image).toEqual(db.export())
  })
})

describe('Detaching a database from its storage', () => {
  test('writes pending commits, then keeps the database in memory', async () => {
    const name = uniqueName()
    const db = await notesDb(name, ['stored'])
    const expected = db.export()
    db.detach()
    await db.flush()
    expect((await stored(name)).image).toEqual(expected)

    // Later commits are neither written nor kept for writing.
    const writes = await countWrites(async () => {
      db.run("insert into notes values ('memory only')")
      await db.flush()
      expect(query(db, 'select count(*) from notes')).toEqual([[2]])
      db.close()
    })
    expect(writes).toBe(0)
    expect((await stored(name)).image).toEqual(expected)
  })

  test('storing the same name again waits for the final write', async () => {
    const name = uniqueName()
    const db = await notesDb(name, ['one', 'two'])
    db.detach()
    const replacement = await syncDb(name)
    expect(query(replacement, 'select count(*) from notes')).toEqual([[2]])
  })

  test('reports a failed final write through flush', async () => {
    const name = uniqueName()
    const db = await notesDb(name, [])
    await db.flush()
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (mode === 'readwrite') throw new Error('Quota exceeded')
      return transaction.call(this, stores, mode, options)
    }
    try {
      db.run("insert into notes values ('lost')")
      db.detach()
      await expect(db.flush()).rejects.toThrow('Quota exceeded')
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
    expect(query(db, 'select count(*) from notes')).toEqual([[1]])
  })

  test('does nothing for in-memory databases', async () => {
    const db = inMemory()
    db.detach()
    await db.flush()
  })

  test('ignores commits after the storage was closed', async () => {
    const db = await notesDb(uniqueName(), [])
    const persistence = db.persistence
    persistence.close()
    await persistence.flush()
    const writes = await countWrites(async () => {
      persistence.commit({
        chunkSize: 4096,
        size: 4096,
        minSize: 4096,
        chunks: new Map([[0, new Uint8Array(4096)]])
      })
      await persistence.flush()
    })
    expect(writes).toBe(0)
    expect(persistence.pending.chunks.size).toBe(0)
  })
})

describe('One database per name', () => {
  test('syncing a name in use fails', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    const error = await Database.sync(indexedDBStorage(name)).catch(e => e)
    expect(error).toBeInstanceOf(SQLiteError)
    expect(error.code).toBe('SQLITE_BUSY')
    // Also while the first one is still opening.
    db.close()
    const first = Database.sync(indexedDBStorage(name))
    const second = Database.sync(indexedDBStorage(name)).catch(e => e)
    open.push(await first)
    expect((await second).code).toBe('SQLITE_BUSY')
  })

  test('attaching to a name in use fails', async () => {
    const name = uniqueName()
    const db = await notesDb(name, ['kept'])
    const other = inMemory()
    const error = await other.attach(indexedDBStorage(name)).catch(e => e)
    expect(error.code).toBe('SQLITE_BUSY')
    expect(other.persistence).toBeUndefined()
    await db.flush()
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('deleting a name in use fails', async () => {
    const name = uniqueName()
    const db = await syncDb(name)
    const storage = indexedDBStorage(name)
    await expect(storage.delete()).rejects.toMatchObject({code: 'SQLITE_BUSY'})
    db.detach()
    await storage.delete()
  })

  test('a failed sync leaves the name free', async () => {
    const name = uniqueName()
    await storeRaw(name, {size: 4096, chunkSize: 4096}, [])
    await expect(Database.sync(indexedDBStorage(name))).rejects.toThrow()
    await indexedDBStorage(name).delete()
    await syncDb(name)
  })
})

describe('SQLite errors', () => {
  test('carry the result code', () => {
    const db = inMemory()
    db.run('create table notes (text primary key)')
    db.run("insert into notes values ('a')")
    const constraint = (() => {
      try {
        db.run("insert into notes values ('a')")
      } catch (error) {
        return error
      }
    })()
    expect(constraint).toBeInstanceOf(SQLiteError)
    expect(constraint.code).toBe('SQLITE_CONSTRAINT')
    expect(constraint.resultCode).toBe(19)
    expect(() => db.run('select * from missing')).toThrow(
      expect.objectContaining({code: 'SQLITE_ERROR'})
    )
  })
})

describe('IndexedDB options', () => {
  test('use the given IndexedDB instead of the global one', async () => {
    const factory = new IDBFactory()
    const name = uniqueName()
    const storage = indexedDBStorage(name, {
      indexedDB: factory,
      IDBKeyRange: FakeKeyRange
    })
    const globals = {indexedDB, IDBKeyRange}
    delete globalThis.indexedDB
    delete globalThis.IDBKeyRange
    try {
      const db = await Database.sync(storage)
      db.run('create table notes (text)')
      db.run("insert into notes values ('injected')")
      db.run('delete from notes')
      db.run('vacuum')
      db.close()
      const reopened = await Database.sync(storage)
      expect(query(reopened, 'select count(*) from notes')).toEqual([[0]])
      reopened.close()
      expect((await factory.databases()).map(info => info.name)).toContain(name)
      await storage.delete()
      expect((await factory.databases()).map(info => info.name)).not.toContain(
        name
      )
    } finally {
      Object.assign(globalThis, globals)
    }
    expect((await indexedDB.databases()).map(info => info.name)).not.toContain(
      name
    )
  })

  test('keep names in different implementations apart', async () => {
    const name = uniqueName()
    const other = indexedDBStorage(name, {
      indexedDB: new IDBFactory(),
      IDBKeyRange: FakeKeyRange
    })
    const db = await syncDb(name)
    const elsewhere = await Database.sync(other)
    open.push(elsewhere)
    db.run('create table here (value)')
    elsewhere.run('create table there (value)')
    await Promise.all([db.flush(), elsewhere.flush()])
    expect((await stored(name)).image).toEqual(db.export())
  })

  test('fail clearly without IndexedDB', async () => {
    const globals = {indexedDB}
    delete globalThis.indexedDB
    try {
      await expect(
        Database.sync(indexedDBStorage(uniqueName()))
      ).rejects.toThrow('IndexedDB is not available')
    } finally {
      Object.assign(globalThis, globals)
    }
  })
})

describe('Corrupt stored databases', () => {
  // Stores meta and chunks, and returns the error syncing them rejects with.
  async function corrupted(meta, chunks) {
    const name = uniqueName()
    await storeRaw(name, meta, chunks)
    const storage = indexedDBStorage(name)
    const error = await Database.sync(storage).then(
      db => {
        open.push(db)
        throw new Error('Loaded a corrupt database')
      },
      error => error
    )
    expect(error).toBeInstanceOf(CorruptDatabaseError)
    expect(error).toBeInstanceOf(SQLiteError)
    expect(error.code).toBe('SQLITE_CORRUPT')
    // Deleting it starts over.
    await storage.delete()
    const fresh = await syncDb(name)
    expect(query(fresh, 'select count(*) from sqlite_schema')).toEqual([[0]])
    return error
  }

  function validImage() {
    const db = new Database()
    try {
      db.run('create table notes (text)')
      db.run("insert into notes values ('x')")
      return db.export()
    } finally {
      db.close()
    }
  }

  function chunked(image, chunkSize = 4096) {
    const chunks = []
    for (let i = 0; i * chunkSize < image.byteLength; i++)
      chunks.push([i, image.slice(i * chunkSize, (i + 1) * chunkSize)])
    return chunks
  }

  test('rejects an invalid meta record', async () => {
    await corrupted({size: 4096, chunkSize: 1000}, [])
    await corrupted({size: -1, chunkSize: 4096}, [])
    await corrupted('garbage', [])
  })

  test('rejects data that is not an SQLite database', async () => {
    const error = await corrupted({size: 8192, chunkSize: 4096}, [
      [0, new Uint8Array(4096).fill(7)],
      [1, new Uint8Array(4096)]
    ])
    expect(error.message).toContain('not an SQLite database')
  })

  test('rejects a missing first chunk', async () => {
    const image = validImage()
    await corrupted(
      {size: image.byteLength, chunkSize: 4096},
      chunked(image).slice(1)
    )
  })

  test('rejects a truncated database', async () => {
    const image = validImage()
    expect(image.byteLength).toBeGreaterThan(4096)
    await corrupted({size: 4096, chunkSize: 4096}, chunked(image).slice(0, 1))
  })

  test('rejects a damaged schema', async () => {
    const image = validImage()
    image.fill(0xff, 100, 4096)
    const error = await corrupted(
      {size: image.byteLength, chunkSize: 4096},
      chunked(image)
    )
    expect(error.cause).toBeDefined()
  })

  test('loads a database that ends in part of a page', async () => {
    // SQLite opens these, for example from bytes with something appended.
    const image = validImage()
    const padded = new Uint8Array(image.byteLength + 100)
    padded.set(image)
    const name = uniqueName()
    await storeRaw(name, {size: padded.byteLength, chunkSize: 4096}, chunked(padded))
    const db = await syncDb(name)
    expect(query(db, 'select text from notes')).toEqual([['x']])
  })

  test('starts empty over chunks without a meta record', async () => {
    const name = uniqueName()
    await storeRaw(name, undefined, chunked(validImage()))
    const db = await syncDb(name)
    expect(query(db, 'select count(*) from sqlite_schema')).toEqual([[0]])
    // Leftover chunks are replaced by the first write.
    db.run('create table other (value)')
    await db.flush()
    const {image, keys, meta} = await stored(name)
    expect(image).toEqual(db.export())
    expect(Math.max(...keys)).toBeLessThan(meta.size / meta.chunkSize)
  })
})
