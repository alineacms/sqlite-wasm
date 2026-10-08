import {afterEach, beforeAll, beforeEach, describe, expect, test} from 'bun:test'
import {init} from '@alinea/sqlite-wasm'
import {
  SnapshotStorage,
  directorySnapshotStore,
  indexedDBSnapshots,
  memorySnapshotStore,
  memorySnapshots,
  readOnlyFile
} from '@alinea/sqlite-wasm/snapshots'
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb'
import {
  MemoryFileReaderSync,
  MemoryLocks,
  MemorySnapshotDirectory
} from './memory-file-system.js'

// Exercise snapshot storage with snapshots as files (in an in-memory directory
// like OPFS, with in-memory Web Locks) and as Blobs in IndexedDB
// (fake-indexeddb), see memory-file-system.js. Storages that share a
// directory or IndexedDB stand in for Workers that share them.

globalThis.FileReaderSync ??= MemoryFileReaderSync

let Database
const open = []

beforeAll(async () => {
  ;({Database} = await init())
})

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close()
    } catch {}
  }
})

function keep(db) {
  open.push(db)
  return db
}

// The session of each database: tests change databases directly and save
// through their sessions. Databases a storage did not open get one from
// the storage that saves them first.
const sessions = new WeakMap()

function register(session) {
  sessions.set(session.db, session)
  return keep(session.db)
}

function sessionOf(db, storage) {
  let session = sessions.get(db)
  if (!session) sessions.set(db, (session = storage.session(db)))
  return session
}

const snapshotOf = db => sessions.get(db)?.snapshot

// Save `db` to `key`, and resolve to the status
function saveTo(storage, db, key, options = {}) {
  return sessionOf(db, storage)
    .save({key, ...options})
    .then(result => result.status)
}

function rows(db, sql) {
  return db.exec(sql)[0]?.values ?? []
}

const dump = db => rows(db, 'select id, body from items order by id')
const held = db => Number(rows(db, 'pragma overlay_pages')[0][0])
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// Every change runs on the database and on a plain in-memory one, which
// the snapshot database must match.
function both(db, reference, change) {
  change(db)
  change(reference)
}

function fill(db, count, size = 500, from = 0) {
  db.run('create table if not exists items (id integer primary key, body text)')
  db.run('begin')
  const insert = db.prepare('insert into items (id, body) values (?, ?)')
  for (let i = from; i < from + count; i++) {
    insert.run([i, `${i} `.padEnd(size, 'x')])
  }
  insert.free()
  db.run('commit')
}

async function bytes(source) {
  return source instanceof Uint8Array
    ? source
    : new Uint8Array(await source.arrayBuffer())
}

const variants = {
  files: {
    locking: true,
    setup() {
      const directory = new MemorySnapshotDirectory()
      const locks = new MemoryLocks()
      return {
        directory,
        locks,
        storage: (options = {}) =>
          new SnapshotStorage(directorySnapshotStore('entries', directory), {
            locks,
            ...options
          })
      }
    }
  },
  indexeddb: {
    locking: false,
    setup() {
      const indexedDB = new IDBFactory()
      return {
        storage: (options = {}) =>
          indexedDBSnapshots('entries', {indexedDB, IDBKeyRange, ...options})
      }
    }
  },
  memory: {
    locking: false,
    setup() {
      const store = memorySnapshotStore()
      return {storage: options => memorySnapshots(store, options)}
    }
  }
}

for (const [variant, {locking, setup}] of Object.entries(variants)) {
  describe(`Snapshots in ${variant}`, () => {
    let storage
    let env

    // Storage options of the current test, see fullSnapshots
    let defaults

    beforeEach(() => {
      env = setup()
      defaults = {}
      storage = (options = {}) => env.storage({...defaults, ...options})
    })

    // Write every snapshot in full in this test, which is about rules that
    // deltas add to (snapshots keep those they lie over)
    function fullSnapshots() {
      defaults = {maxDepth: 0}
    }

    async function openDb(which) {
      const options = typeof which === 'string' ? {key: which} : which
      return register(await storage().open(Database, options))
    }

    const save = (db, key, options) => saveTo(storage(), db, key, options)

    // Put `data` in base `key` as it is, damaged or not.
    function put(key, data, branch = '') {
      return storage().store.write({
        key,
        branch,
        meta: {},
        base: data,
        visible: data.byteLength,
        size: data.byteLength,
        chunkSize: 4096,
        pages: [],
        page() {}
      })
    }

    // The database snapshot `key` holds, as stored, also for a delta
    async function content(key) {
      const session = await storage().open(Database, {key})
      try {
        return session.db.export()
      } finally {
        await session.close()
      }
    }

    describe('Opening', () => {
      test('starts an empty database without bases', async () => {
        const db = await openDb()
        expect(rows(db, 'select count(*) from sqlite_schema')).toEqual([[0]])
        expect(db.base).toBeUndefined()
      })

      test('reads pages from the base and keeps changes in memory', async () => {
        const db = await openDb()
        fill(db, 2000)
        expect(await save(db, 'v1')).toBe('written')
        const written = await content('v1')
        const other = await openDb('v1')
        expect(held(other)).toBe(0)
        expect(rows(other, 'select count(*), sum(length(body)) from items'))
          .toEqual([[2000, 1_000_000]])
        expect(held(other)).toBe(0)
        // Pages read from the base stay in a larger page cache, also in forks.
        expect(rows(other, 'pragma cache_size')).toEqual([[-8192]])
        expect(rows(keep(other.fork()), 'pragma cache_size')).toEqual([[-8192]])
        other.run("update items set body = 'changed' where id < 10")
        expect(held(other)).toBeGreaterThan(0)
        expect(rows(db, "select count(*) from items where body = 'changed'"))
          .toEqual([[0]])
        // The base is never written.
        expect(await content('v1')).toEqual(written)
      })

      test('picks the head, of all or of a branch, or a snapshot by key', async () => {
        const db = await openDb()
        fill(db, 10)
        await save(db, 'b', {branch: 'one'})
        db.run('delete from items where id >= 5')
        await save(db, 'a', {branch: 'two', meta: {tree: 'x'}})
        db.run('delete from items where id >= 3')
        // Saves to the branch of the last save.
        await save(db, 'c')
        const list = await storage().list()
        expect(list.map(({key, branch, meta}) => ({key, branch, meta}))).toEqual([
          {key: 'c', branch: 'two', meta: {}},
          {key: 'a', branch: 'two', meta: {tree: 'x'}},
          {key: 'b', branch: 'one', meta: {}}
        ])
        expect(list[0].size).toBe((await content('c')).byteLength)
        expect(list[0].createdAt).toBeGreaterThan(list[1].createdAt)
        const count = async which =>
          rows(await openDb(which), 'select count(*) from items')[0][0]
        expect(await count()).toBe(3)
        expect(await count({branch: 'one'})).toBe(10)
        expect(await count({branch: 'two'})).toBe(3)
        expect(await count({key: 'a'})).toBe(5)
        expect(await count('b')).toBe(10)
        expect(db.base.branch).toBe('two')
        // A branch without snapshots starts empty, or with fallback, on the
        // head of all; session.snapshot tells which.
        expect(snapshotOf(await openDb({branch: 'three'}))).toBeUndefined()
        const fallback = await openDb({branch: 'three', fallback: 'any-branch'})
        expect(snapshotOf(fallback)).toEqual(list[0])
        expect(snapshotOf(await openDb({branch: 'one', fallback: 'any-branch'})).key).toBe('b')
        // A database follows its saves.
        expect(snapshotOf(db)).toEqual(list[0])
        expect(snapshotOf(keep(new Database()))).toBeUndefined()
      })

      test('skips empty bases, which are being written', async () => {
        const db = await openDb()
        fill(db, 10)
        await save(db, 'v1')
        await put('v2', new Uint8Array(0))
        expect(rows(await openDb(), 'select count(*) from items')).toEqual([[10]])
        await expect(storage().open(Database, {key: 'v2'}))
          .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
      })

      test('fails with SQLITE_CANTOPEN for a missing base', async () => {
        await expect(storage().open(Database, {key: 'missing'}))
          .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
      })

      test('fails with SQLITE_CORRUPT for a damaged base', async () => {
        const db = await openDb()
        fill(db, 1000)
        await save(db, 'good')
        const good = await content('good')
        await put('garbage', new Uint8Array(8192).fill(7))
        await put('truncated', good.slice(0, good.byteLength / 2))
        const schema = good.slice()
        schema.fill(0xff, 100, 4096)
        await put('schema', schema)
        for (const key of ['garbage', 'truncated', 'schema']) {
          await expect(storage().open(Database, key))
            .rejects.toMatchObject({code: 'SQLITE_CORRUPT'})
        }
        // Nothing stays locked: only db holds a lock, on good. The newest
        // base is kept, damaged or not.
        if (locking) expect(env.locks.held.size).toBe(1)
        expect((await storage().retain()).sort()).toEqual(
          locking ? ['garbage', 'truncated'] : ['garbage', 'good', 'truncated']
        )
        expect(rows(db, 'select count(*) from items')).toEqual([[1000]])
      })
    })

    describe('Checkpoints', () => {
      test('write the changes, rebase, and match the same changes without snapshots', async () => {
        const db = await openDb()
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 3000))
        expect(await save(db, 'v1')).toBe('written')
        // Every page is in the base now.
        expect(held(db)).toBe(0)
        expect(db.export()).toEqual(reference.export())

        both(db, reference, db => {
          db.run("update items set body = 'one' where id % 7 = 0")
          db.run('delete from items where id between 100 and 400')
          fill(db, 50, 2000, 5000)
        })
        expect(held(db)).toBeGreaterThan(0)
        const fork = keep(db.fork())
        const atFork = dump(fork)
        expect(await save(db, 'v2')).toBe('written')
        expect(held(db)).toBe(0)
        expect(db.export()).toEqual(reference.export())
        // The fork still reads the first base, unchanged.
        expect(dump(fork)).toEqual(atFork)
        fork.run("update items set body = 'fork' where id = 1")
        expect(rows(db, 'select body from items where id = 1')).not.toEqual([['fork']])

        both(db, reference, db => db.run("update items set body = 'two' where id < 50"))
        const reopened = await openDb('v2')
        expect(dump(reopened)).toEqual(atFork)
        expect(dump(db)).toEqual(dump(reference))
        expect(db.export()).toEqual(reference.export())
      })

      test('keep a database right when it shrinks and grows again', async () => {
        const db = await openDb()
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 3000))
        await save(db, 'v1')
        both(db, reference, db => {
          db.run('delete from items where id >= 200')
          db.run('vacuum')
        })
        expect(dump(db)).toEqual(dump(reference))
        await save(db, 'v2')
        expect((await content('v2')).byteLength)
          .toBeLessThan((await content('v1')).byteLength / 5)
        // Shrink below the new base and grow past it before the next one.
        both(db, reference, db => {
          db.run('delete from items where id >= 20')
          db.run('vacuum')
          fill(db, 1000, 700, 10_000)
        })
        expect(db.export()).toEqual(reference.export())
        await save(db, 'v3')
        expect(db.export()).toEqual(reference.export())
        const reopened = await openDb('v3')
        expect(reopened.export()).toEqual(reference.export())
      })

      test('rebase without losing what changed while the base was written', async () => {
        const db = await openDb()
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 3000))
        await save(db, 'v1')
        both(db, reference, db => db.run("update items set body = 'before' where id < 1000"))
        const atCheckpoint = keep(reference.fork())
        let done = false
        const checkpoint = save(db, 'v2').finally(() => (done = true))
        let writes = 0
        while (!done) {
          both(db, reference, db =>
            db.run(`update items set body = 'during ${writes}' where id = ${writes * 7}`)
          )
          writes++
          await tick()
        }
        expect(await checkpoint).toBe('written')
        // At least one, made after checkpoint was called
        expect(writes).toBeGreaterThan(0)
        // The base holds the state the checkpoint started from, the
        // database everything.
        const reopened = await openDb('v2')
        expect(reopened.export()).toEqual(atCheckpoint.export())
        expect(db.export()).toEqual(reference.export())
        expect(held(db)).toBeGreaterThan(0)
        expect(held(db)).toBeLessThan(writes * 3)
      })

      test('run one at a time per database, each from when it was called', async () => {
        const db = await openDb()
        fill(db, 100)
        const first = save(db, 'v1')
        db.run('delete from items where id >= 50')
        const second = save(db, 'v2')
        db.run('delete from items where id >= 20')
        const third = save(db, 'v3')
        expect(await Promise.all([first, second, third])).toEqual(['written', 'written', 'written'])
        expect(rows(await openDb('v1'), 'select count(*) from items')).toEqual([[100]])
        expect(rows(await openDb('v2'), 'select count(*) from items')).toEqual([[50]])
        expect(rows(await openDb('v3'), 'select count(*) from items')).toEqual([[20]])
        expect(db.base.key).toBe('v3')
        expect(held(db)).toBe(0)
      })

      test('skip a key that exists, leaving the database as it is', async () => {
        const a = await openDb()
        fill(a, 100)
        await save(a, 'v1')
        const written = await content('v1')
        const b = await openDb('v1')
        b.run('delete from items where id >= 10')
        const pages = held(b)
        expect(await save(b, 'v1')).toBe('mismatch')
        expect(await content('v1')).toEqual(written)
        expect(held(b)).toBe(pages)
        expect(rows(b, 'select count(*) from items')).toEqual([[10]])
        expect(rows(await openDb('v1'), 'select count(*) from items')).toEqual([[100]])
      })

      test('write a key once when two databases race for it', async () => {
        const a = await openDb()
        const b = await openDb()
        fill(a, 100)
        fill(b, 100)
        const results = await Promise.all([
          save(a, 'same'),
          save(b, 'same')
        ])
        expect([...results].sort()).toEqual(['joined', 'written'])
        // The other finds the same content there, and reads it too.
        for (const db of [a, b]) {
          expect(db.base.key).toBe('same')
          expect(held(db)).toBe(0)
        }
      })

      test('move onto a key that exists with the same content', async () => {
        const a = await openDb()
        const b = await openDb()
        fill(a, 100)
        fill(b, 100)
        expect(await save(a, 'same')).toBe('written')
        const written = await content('same')
        expect(held(b)).toBeGreaterThan(0)
        expect(await save(b, 'same')).toBe('joined')
        expect(await content('same')).toEqual(written)
        expect(held(b)).toBe(0)
        expect(snapshotOf(b).key).toBe('same')
        expect(dump(b)).toEqual(dump(a))
        b.run('delete from items where id >= 10')
        expect(rows(b, 'select count(*) from items')).toEqual([[10]])
        expect(rows(a, 'select count(*) from items')).toEqual([[100]])
      })

      test('move onto a key that exists from the same base', async () => {
        fullSnapshots()
        const first = await openDb()
        fill(first, 2000)
        await save(first, 'v1')
        first.close()
        const a = await openDb('v1')
        const b = await openDb('v1')
        for (const db of [a, b])
          db.run("update items set body = 'changed' where id % 100 = 0")
        expect(await save(a, 'v2')).toBe('written')
        expect(await save(b, 'v2')).toBe('joined')
        expect(held(b)).toBe(0)
        expect(snapshotOf(b).key).toBe('v2')
        expect(b.export()).toEqual(a.export())
        // Nobody reads v1 anymore; with locks, both hold v2.
        expect(await storage().retain()).toEqual(['v1'])
        if (locking)
          expect([...env.locks.held.values()].map(lock => lock.count))
            .toEqual([2])
        expect(rows(keep(b.fork()), 'select count(*) from items'))
          .toEqual([[2000]])
      })

      test('stay on the base when a key exists with other content', async () => {
        const a = await openDb()
        const b = await openDb()
        const c = await openDb()
        fill(a, 100)
        fill(b, 200)
        // The same size, but other bytes
        fill(c, 100)
        c.run("update items set body = replace(body, 'x', 'y')")
        expect(rows(c, 'pragma page_count')).toEqual(rows(a, 'pragma page_count'))
        expect(await save(a, 'same')).toBe('written')
        for (const db of [b, c]) {
          const pages = held(db)
          expect(await save(db, 'same')).toBe('mismatch')
          expect(held(db)).toBe(pages)
          expect(snapshotOf(db)).toBeUndefined()
        }
        expect(rows(b, 'select count(*) from items')).toEqual([[200]])
        expect(rows(c, "select count(*) from items where body like '%y'"))
          .toEqual([[100]])
      })

      test('compare bases larger than one read', async () => {
        const first = await openDb()
        fill(first, 7000, 1000)
        await save(first, 'v1')
        first.close()
        const change = (db, last) => {
          db.run('begin')
          db.run("update items set body = 'first' where id < 10")
          db.run('update items set body = ? where id = 6999', [last])
          db.run('commit')
        }
        const a = await openDb('v1')
        const b = await openDb('v1')
        const c = await openDb('v1')
        change(a, 'last')
        change(b, 'last')
        change(c, 'other')
        expect(await save(a, 'v2')).toBe('written')
        expect(await save(b, 'v2')).toBe('joined')
        expect(held(b)).toBe(0)
        expect(snapshotOf(b).key).toBe('v2')
        expect(await save(c, 'v2')).toBe('mismatch')
        expect(held(c)).toBeGreaterThan(0)
        expect(snapshotOf(c).key).toBe('v1')
        // c differs from v2 only past the first read of 4 MB.
        await save(c, 'c2')
        const v2 = await content('v2')
        const c2 = await content('c2')
        expect(v2.byteLength).toBeGreaterThan(5 << 20)
        expect(c2.byteLength).toBe(v2.byteLength)
        expect(v2.findIndex((byte, i) => byte !== c2[i]))
          .toBeGreaterThan(4 << 20)
        expect(rows(c, 'select body from items where id = 6999'))
          .toEqual([['other']])
      })

      test('move a queued snapshot along onto a key that exists', async () => {
        const first = await openDb()
        fill(first, 1000)
        await save(first, 'v1')
        first.close()
        const twin = await openDb('v1')
        const db = await openDb('v1')
        for (const it of [twin, db])
          it.run("update items set body = 'one' where id < 300")
        expect(await save(twin, 'v2')).toBe('written')
        const second = save(db, 'v2')
        db.run('delete from items where id >= 700')
        const third = save(db, 'v3')
        expect(await Promise.all([second, third])).toEqual(['joined', 'written'])
        // The third snapshot followed db onto v2, and wrote v3 over it.
        expect(db.base.key).toBe('v3')
        expect(held(db)).toBe(0)
        const reopened = await openDb('v3')
        expect(rows(reopened, "select count(*), sum(body = 'one') from items"))
          .toEqual([[700, 300]])
        expect(dump(reopened)).toEqual(dump(db))
      })

      test('join the key a database reads when nothing changed, else mismatch', async () => {
        const a = await openDb()
        fill(a, 100)
        await save(a, 'v1')
        const b = await openDb('v1')
        for (const db of [a, b]) {
          const base = db.base
          expect(await save(db, 'v1')).toBe('joined')
          expect(db.base).toBe(base)
          expect(held(db)).toBe(0)
        }
        b.run('delete from items where id = 1')
        expect(await save(b, 'v1')).toBe('mismatch')
        expect(held(b)).toBeGreaterThan(0)
      })

      test('move a database in a transaction that wrote pages meanwhile', async () => {
        const db = await openDb()
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 1000))
        await save(db, 'v1')
        both(db, reference, db => db.run("update items set body = 'one' where id < 100"))
        const checkpoint = save(db, 'v2')
        // A small page cache makes the transaction write its pages.
        db.run('pragma cache_size = 2')
        both(db, reference, db => {
          db.run('begin')
          db.run("update items set body = 'two' where id >= 500")
          db.run("insert into items (body) values ('three')")
        })
        expect(await checkpoint).toBe('written')
        expect(db.base.key).toBe('v2')
        both(db, reference, db => db.run('commit'))
        expect(db.export()).toEqual(reference.export())
        db.run('begin')
        db.run('delete from items')
        db.run('rollback')
        expect(db.export()).toEqual(reference.export())
      })

      test('write the base of a database closed meanwhile', async () => {
        fullSnapshots()
        const db = await openDb()
        fill(db, 100)
        await save(db, 'v1')
        db.run('delete from items where id >= 10')
        const checkpoint = save(db, 'v2')
        db.close()
        expect(await checkpoint).toBe('written')
        expect(rows(await openDb('v2'), 'select count(*) from items')).toEqual([[10]])
        // Only the database just opened holds a lock.
        if (locking) expect(env.locks.held.size).toBe(1)
      })

      test('keep a database right when moving a later snapshot fails', async () => {
        fullSnapshots()
        const db = await openDb()
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 1000))
        await save(db, 'v0')
        const proto = Object.getPrototypeOf(db)
        const rebase = proto.rebase
        let calls = 0
        let atSecond
        proto.rebase = function (...args) {
          if (++calls === 2) throw new Error('injected')
          return rebase.apply(this, args)
        }
        try {
          both(db, reference, db => db.run("update items set body = 'one' where id < 300"))
          const first = save(db, 'v1')
          both(db, reference, db => db.run("update items set body = 'two' where id >= 700"))
          atSecond = keep(reference.fork())
          const second = save(db, 'v2')
          expect(await Promise.all([first, second])).toEqual(['written', 'written'])
        } finally {
          proto.rebase = rebase
        }
        // The second snapshot could not move: it wrote from v0, and db
        // stays on v1, which it still reads.
        expect(db.base.key).toBe('v1')
        expect((await openDb('v2')).export()).toEqual(atSecond.export())
        expect((await storage().retain()).sort()).toEqual(
          locking ? ['v0'] : ['v0', 'v1']
        )
        expect(db.export()).toEqual(reference.export())
        both(db, reference, db => db.run('delete from items where id % 3 = 0'))
        await save(db, 'v3')
        expect(db.base.key).toBe('v3')
        expect((await openDb('v3')).export()).toEqual(reference.export())
      })

      test('default to the branch a session was opened for', async () => {
        const db = await openDb()
        fill(db, 10)
        await save(db, 'one', {branch: 'cfg1'})
        const other = await openDb({branch: 'cfg2', fallback: 'any-branch'})
        expect(snapshotOf(other).branch).toBe('cfg1')
        other.run('delete from items where id = 1')
        await save(other, 'two')
        expect(snapshotOf(other).branch).toBe('cfg2')
        // And to the branch of its last save, also while it is pending.
        other.run('delete from items where id = 2')
        const three = save(other, 'three', {branch: 'cfg3'})
        other.run('delete from items where id = 3')
        const four = save(other, 'four')
        await Promise.all([three, four])
        expect(snapshotOf(other).branch).toBe('cfg3')
      })

      test('release every base of a database closed with checkpoints queued', async () => {
        fullSnapshots()
        const db = await openDb()
        fill(db, 100)
        await save(db, 'v1')
        const queued = []
        for (let i = 2; i <= 4; i++) {
          db.run(`delete from items where id = ${i}`)
          queued.push(save(db, `v${i}`))
        }
        db.close()
        expect(await Promise.all(queued)).toEqual(['written', 'written', 'written'])
        if (locking) {
          // Locks are released once the last snapshot closes, a tick later.
          await tick()
          expect(env.locks.held.size).toBe(0)
        }
        expect((await storage().retain()).sort()).toEqual(['v1', 'v2', 'v3'])
        expect(rows(await openDb(), 'select count(*) from items')).toEqual([[97]])
      })

      test('fail during a write transaction', async () => {
        const db = await openDb()
        fill(db, 10)
        db.run('begin')
        db.run('delete from items')
        await expect(save(db, 'v1'))
          .rejects.toMatchObject({code: 'SQLITE_BUSY'})
        db.run('commit')
        expect(await save(db, 'v1')).toBe('written')
      })

      test('store databases loaded into memory', async () => {
        const source = keep(new Database())
        fill(source, 500)
        const db = keep(new Database(source.export()))
        await save(db, 'loaded')
        expect(held(db)).toBe(0)
        expect(rows(await openDb('loaded'), 'select count(*) from items'))
          .toEqual([[500]])
      })
    })

    describe('Automatic checkpoints', () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      async function until(condition) {
        for (let i = 0; i < 500; i++) {
          if (await condition()) return
          await wait(5)
        }
        throw new Error('timed out')
      }
      // Bases written in full (files appear empty while they are written)
      const keys = async () =>
        (await storage().list()).filter(base => base.size > 0).map(base => base.key)

      test('are off unless after or maxHeld is given', async () => {
        const db = await openDb({autoSave: {}})
        fill(db, 100)
        await wait(50)
        expect(await keys()).toEqual([])
      })

      test('wait for commits to stop, after', async () => {
        let n = 0
        const db = await openDb({
          branch: 'g',
          autoSave: {after: 40, key: () => `v${++n}`, meta: db => ({rows: rows(db, 'select count(*) from items')[0][0]})}
        })
        for (let i = 0; i < 5; i++) {
          fill(db, 10, 100, i * 10)
          await wait(10)
        }
        expect(await keys()).toEqual([])
        await until(async () => (await keys()).length === 1)
        await wait(60)
        const [base] = await storage().list()
        expect(base).toMatchObject({key: 'v1', branch: 'g', meta: {rows: 50}})
        expect(snapshotOf(db).key).toBe('v1')
        expect(held(db)).toBe(0)
      })

      test('bound the pages held, with maxHeld', async () => {
        const reference = keep(new Database())
        const db = await openDb({autoSave: {maxHeld: 256 << 10}})
        for (let i = 0; i < 20; i++) {
          both(db, reference, db => fill(db, 100, 500, i * 100))
          await tick()
          await tick()
        }
        await until(async () => (await keys()).length > 1)
        // Let the last checkpoint finish.
        await wait(50)
        const bases = await keys()
        // Each with a key of its own
        expect(new Set(bases).size).toBe(bases.length)
        // Pages of 4 KB: below the limit plus one more commit
        expect(held(db) * 4096).toBeLessThan(512 << 10)
        expect(db.export()).toEqual(reference.export())
      })

      test('skip a checkpoint when key returns undefined', async () => {
        let ready = false
        const db = await openDb({autoSave: {after: 10, key: () => (ready ? 'ready' : undefined)}})
        fill(db, 10)
        await wait(40)
        expect(await keys()).toEqual([])
        ready = true
        db.run("insert into items (body) values ('more')")
        await until(async () => (await keys()).length === 1)
        expect(await keys()).toEqual(['ready'])
      })

      test('never start inside a transaction', async () => {
        const db = await openDb({autoSave: {after: 10}})
        fill(db, 10)
        db.run('begin')
        await wait(1)
        db.run('delete from items')
        await wait(40)
        // The wait ended inside the transaction: nothing was written.
        expect(await keys()).toEqual([])
        db.run('commit')
        await until(async () => (await keys()).length === 1)
        expect(rows(await openDb((await keys())[0]), 'select count(*) from items')).toEqual([[0]])
      })

      test('stop when the session or its database closes', async () => {
        const db = await openDb({autoSave: {after: 10}})
        fill(db, 10)
        db.close()
        await wait(40)
        expect(await keys()).toEqual([])
        const session = await storage().open(Database, {autoSave: {after: 10}})
        fill(session.db, 10)
        await session.close()
        await wait(40)
        expect(await keys()).toEqual([])
      })

      test('save sessions made for databases a storage did not open', async () => {
        const db = keep(new Database())
        storage().session(db, {branch: 'loaded', autoSave: {after: 10}})
        fill(db, 10)
        await until(async () => (await keys()).length === 1)
        expect((await storage().head('loaded')).size).toBeGreaterThan(0)
      })

      test('report errors', async () => {
        const errors = []
        const db = await openDb({
          autoSave: {
            after: 5,
            key: () => {
              throw new Error('no key')
            },
            onError: error => errors.push(error.message)
          }
        })
        fill(db, 10)
        await until(() => errors.length > 0)
        expect(errors).toEqual(['no key'])
      })
    })

    describe('Deltas', () => {
      // What is stored for `key`: a delta's pages, or the whole database
      async function stored(key) {
        const found = await storage().store.get(key)
        return {...found, bytes: (await bytes(found.source)).byteLength}
      }

      test('store only the pages that changed, over the snapshot below', async () => {
        const session = await storage().open(Database)
        const db = register(session)
        fill(db, 3000)
        await session.save({key: 'v1'})
        const full = await stored('v1')
        expect(full.delta).toBeUndefined()
        db.run("update items set body = 'changed' where id < 20")
        const pages = held(db)
        await session.save({key: 'v2'})
        const delta = await stored('v2')
        expect(delta.info.parent).toBe('v1')
        expect(delta.delta).toMatchObject({parent: 'v1', depth: 1, chainBytes: pages * 4096})
        expect(delta.delta.pages.length).toBe(pages)
        expect(delta.bytes).toBe(pages * 4096)
        expect(delta.info.size).toBe(full.info.size)
        expect(session.snapshot).toMatchObject({key: 'v2', parent: 'v1'})
        expect((await storage().list())[0]).toMatchObject({key: 'v2', parent: 'v1'})
        // Read back through both
        const reopened = await openDb('v2')
        expect(reopened.export()).toEqual(db.export())
        expect(rows(reopened, "select count(*) from items where body = 'changed'"))
          .toEqual([[20]])
      })

      test('write in full past maxDepth, or once deltas outweigh the database', async () => {
        const session = await storage({maxDepth: 2}).open(Database)
        const db = register(session)
        fill(db, 2000)
        const parents = []
        for (let i = 1; i <= 4; i++) {
          db.run(`update items set body = 'v${i}' where id = ${i * 300}`)
          await session.save({key: `v${i}`})
          parents.push((await stored(`v${i}`)).info.parent ?? null)
        }
        // v1 has no snapshot below; v2 and v3 are deltas; v4 would be the
        // third delta.
        expect(parents).toEqual([null, 'v1', 'v2', null])
        // Changing every page writes in full too.
        db.run("update items set body = replace(body, 'x', 'y')")
        await session.save({key: 'all'})
        expect((await stored('all')).delta).toBeUndefined()
        expect(dump(await openDb('all'))).toEqual(dump(db))
        expect(() => storage({maxDepth: -1})).toThrow(RangeError)
      })

      test('read a chain the database grew and changed along', async () => {
        const session = await storage().open(Database)
        const db = register(session)
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 3000))
        await session.save({key: 'v1'})
        both(db, reference, db => db.run('delete from items where id >= 2500'))
        await session.save({key: 'v2'})
        both(db, reference, db => fill(db, 300, 1000, 10_000))
        await session.save({key: 'v3'})
        both(db, reference, db => db.run('delete from items where id < 100'))
        await session.save({key: 'v4'})
        const [v1, v3, v4] = [await stored('v1'), await stored('v3'), await stored('v4')]
        expect(v3.info.parent).toBe('v2')
        expect(v4.info.parent).toBe('v3')
        expect(v4.delta.depth).toBe(3)
        // v3 grew past the end of v1.
        expect(v3.info.size).toBeGreaterThan(v1.info.size)
        for (const [key, count] of [['v1', 3000], ['v2', 2500], ['v3', 2800], ['v4', 2700]])
          expect(rows(await openDb(key), 'select count(*) from items')).toEqual([[count]])
        // Bytes of free pages may differ from a plain database's, whose
        // page cache can hold what SQLite never wrote.
        const v4db = await openDb('v4')
        expect(dump(v4db)).toEqual(dump(reference))
        expect(rows(v4db, 'pragma page_count')).toEqual(rows(reference, 'pragma page_count'))
        expect(rows(v4db, 'pragma freelist_count')).toEqual(rows(reference, 'pragma freelist_count'))
      })

      test('fail to open when a snapshot below is missing', async () => {
        const session = await storage().open(Database)
        register(session)
        fill(session.db, 100)
        await session.save({key: 'v1'})
        session.db.run('delete from items where id = 1')
        await session.save({key: 'v2'})
        await storage().store.remove('v1')
        await expect(storage().open(Database, {key: 'v2'}))
          .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
        // The session read v2 before: it keeps working.
        expect(rows(session.db, 'select count(*) from items')).toEqual([[99]])
      })

      test('keep the snapshots that kept ones lie over', async () => {
        const session = await storage().open(Database, {branch: 'main'})
        const db = register(session)
        fill(db, 500)
        for (const key of ['v1', 'v2', 'v3']) {
          db.run(`insert into items (body) values ('${key}')`)
          await session.save({key})
        }
        // v3 lies over v2 over v1: nothing can go.
        expect(await storage().retain()).toEqual([])
        db.close()
        // Once a full snapshot is newest, the chain below it can.
        const full = storage({maxDepth: 0})
        const next = await full.open(Database, {branch: 'main'})
        register(next)
        next.db.run("insert into items (body) values ('v4')")
        await next.save({key: 'v4'})
        await next.close()
        expect((await full.retain()).sort()).toEqual(['v1', 'v2', 'v3'])
        expect(rows(await openDb({branch: 'main'}), 'select count(*) from items'))
          .toEqual([[504]])
      })

      if (locking) {
        test('hold the snapshots below the one a database reads', async () => {
          const session = await storage().open(Database, {branch: 'main'})
          register(session)
          fill(session.db, 500)
          await session.save({key: 'v1'})
          session.db.run('delete from items where id = 1')
          await session.save({key: 'v2'})
          const reader = await openDb('v2')
          await session.close()
          // A full snapshot replaces the chain, but reader still reads it.
          const full = storage({maxDepth: 0})
          const next = await full.open(Database, {branch: 'main'})
          register(next)
          next.db.run('delete from items where id = 2')
          await next.save({key: 'v3'})
          expect(await full.retain()).toEqual([])
          reader.close()
          expect((await full.retain()).sort()).toEqual(['v1', 'v2'])
        })
      }
    })

    describe('Sessions', () => {
      test('tell the snapshot, branch and bytes held', async () => {
        const session = await storage().open(Database, {branch: 'main'})
        keep(session.db)
        expect(session.snapshot).toBeUndefined()
        expect(session.branch).toBe('main')
        fill(session.db, 100)
        expect(session.held).toBe(held(session.db) * 4096)
        const result = await session.save({key: 'v1', meta: {n: 1}})
        expect(result).toEqual({status: 'written', snapshot: session.snapshot})
        expect(session.snapshot).toMatchObject({key: 'v1', branch: 'main', meta: {n: 1}})
        expect(session.held).toBe(0)
        // Saving to another branch moves the session to it.
        session.db.run('delete from items where id = 1')
        await session.save({branch: 'other'})
        expect(session.branch).toBe('other')
        expect(session.snapshot.key).toMatch(/^auto-/)
      })

      test('report the snapshot a mismatch found', async () => {
        const a = await storage().open(Database)
        const b = await storage().open(Database)
        keep(a.db)
        keep(b.db)
        fill(a.db, 10)
        fill(b.db, 20)
        await a.save({key: 'same', meta: {by: 'a'}})
        const result = await b.save({key: 'same'})
        expect(result.status).toBe('mismatch')
        expect(result.snapshot).toMatchObject({key: 'same', meta: {by: 'a'}})
        expect(b.snapshot).toBeUndefined()
      })

      test('fork with their changes and branch, and save on their own', async () => {
        const session = await storage().open(Database, {branch: 'main'})
        keep(session.db)
        fill(session.db, 100)
        await session.save({key: 'v1'})
        session.db.run('delete from items where id >= 50')
        const draft = session.fork()
        keep(draft.db)
        expect(draft.branch).toBe('main')
        expect(draft.snapshot.key).toBe('v1')
        draft.db.run('delete from items where id >= 10')
        expect((await draft.save({key: 'draft'})).status).toBe('written')
        expect(rows(session.db, 'select count(*) from items')).toEqual([[50]])
        expect(session.snapshot.key).toBe('v1')
        expect(rows(await openDb('draft'), 'select count(*) from items')).toEqual([[10]])
      })

      test('save on close when asked, and wait for queued saves', async () => {
        const session = await storage().open(Database)
        fill(session.db, 100)
        const queued = session.save({key: 'v1'})
        session.db.run('delete from items where id >= 10')
        await session.close({save: {key: 'v2'}})
        expect(session.db.isClosed()).toBe(true)
        expect((await queued).status).toBe('written')
        expect(rows(await openDb('v2'), 'select count(*) from items')).toEqual([[10]])
        // Closing twice does nothing.
        await session.close()
      })

      test('refuse databases stored elsewhere', () => {
        const db = keep(new Database())
        db.persistence = {flush: async () => {}, close() {}}
        expect(() => storage().session(db)).toThrow(
          expect.objectContaining({code: 'SQLITE_MISUSE'})
        )
        db.persistence = undefined
      })
    })

    describe('Forks', () => {
      test('keep reading their base after the database closes and moves on', async () => {
        fullSnapshots()
        const db = await openDb()
        fill(db, 1000)
        await save(db, 'v1')
        const fork = keep(db.fork())
        const forkOfFork = keep(fork.fork())
        db.run('delete from items')
        await save(db, 'v2')
        db.close()
        expect(rows(fork, 'select count(*) from items')).toEqual([[1000]])
        if (locking) {
          // They hold the lock on v1 between them.
          expect(await storage().retain()).toEqual([])
          fork.close()
          expect(await storage().retain()).toEqual([])
          forkOfFork.close()
        }
        expect(await storage().retain()).toEqual(['v1'])
        // A fresh fork reads every page from the base again.
        if (!locking) {
          const fresh = keep(forkOfFork.fork())
          expect(rows(fresh, 'select count(*), sum(length(body)) from items'))
            .toEqual([[1000, 500_000]])
        }
      })

      test('can be saved themselves', async () => {
        const db = await openDb()
        fill(db, 100)
        await save(db, 'v1')
        const fork = keep(db.fork())
        fork.run('delete from items where id >= 30')
        expect(await save(fork, 'fork')).toBe('written')
        expect(held(fork)).toBe(0)
        expect(rows(await openDb('fork'), 'select count(*) from items')).toEqual([[30]])
        expect(rows(db, 'select count(*) from items')).toEqual([[100]])
      })
    })

    describe('Cleanup', () => {
      test('keeps the head of each branch', async () => {
        fullSnapshots()
        const db = await openDb()
        fill(db, 10)
        for (const key of ['a1', 'a2', 'a3']) {
          db.run(`insert into items (body) values ('${key}')`)
          await save(db, key, {branch: 'a'})
        }
        const other = keep(new Database())
        fill(other, 5)
        await save(other, 'b1', {branch: 'b'})
        other.run('delete from items where id = 1')
        await save(other, 'b2')
        other.close()
        expect((await storage().retain()).sort()).toEqual(['a1', 'a2', 'b1'])
        expect((await storage().list()).map(base => base.key).sort()).toEqual(['a3', 'b2'])
        expect(rows(await openDb({branch: 'a'}), 'select count(*) from items')).toEqual([[13]])
      })

      test('refuses counts that are not whole numbers', async () => {
        for (const branches of [-1, 1.5, NaN])
          await expect(storage().retain({branches})).rejects.toThrow(RangeError)
        for (const perBranch of [0, 2.5])
          await expect(storage().retain({perBranch})).rejects.toThrow(RangeError)
      })

      test('keeps more per branch, and pinned keys', async () => {
        fullSnapshots()
        const db = await openDb()
        fill(db, 10)
        for (const key of ['v1', 'v2', 'v3', 'v4']) {
          db.run(`insert into items (body) values ('${key}')`)
          await save(db, key)
        }
        db.close()
        expect((await storage().retain({perBranch: 2, pinned: ['v1']})).sort())
          .toEqual(['v2'])
        expect((await storage().list()).map(s => s.key)).toEqual(['v4', 'v3', 'v1'])
      })

      test('keeps the newest branches only, with branches', async () => {
        const db = await openDb()
        fill(db, 10)
        for (const [key, branch] of [['a1', 'a'], ['b1', 'b'], ['a2', 'a'], ['c1', 'c'], ['b2', 'b']]) {
          db.run(`insert into items (body) values ('${key}')`)
          await save(db, key, {branch})
        }
        db.close()
        // Newest first: b (b2), c (c1), a (a2)
        expect((await storage().retain({branches: 2})).sort())
          .toEqual(['a1', 'a2', 'b1'])
        expect((await storage().list()).map(base => base.key)).toEqual(['b2', 'c1'])
      })

      if (locking) {
        test('keeps bases a database reads', async () => {
        fullSnapshots()
          const a = await openDb()
          fill(a, 10)
          await save(a, 'v1')
          const b = await openDb('v1')
          b.run('delete from items where id = 1')
          await save(b, 'v2')
          b.run('delete from items where id = 2')
          await save(b, 'v3')
          // a reads v1, b reads v3, which is newest.
          expect(await storage().retain()).toEqual(['v2'])
          a.close()
          expect(await storage().retain()).toEqual(['v1'])
          b.close()
          expect(await storage().retain()).toEqual([])
          expect(rows(await openDb(), 'select count(*) from items')).toEqual([[8]])
        })

        test('does not delete a base while a checkpoint writes it', async () => {
        fullSnapshots()
          const db = await openDb()
          fill(db, 100)
          await save(db, 'v1')
          db.run('delete from items')
          const checkpoint = save(db, 'v2')
          // Wait until v2 exists, empty, while it is written.
          while (!(await storage().list()).some(base => base.key === 'v2')) await tick()
          expect(await storage().retain()).toEqual([])
          await checkpoint
          expect(await storage().retain()).toEqual(['v1'])
        })

        test('tells the newest base apart when file times are equal', async () => {
          const db = await openDb()
          fill(db, 10)
          await save(db, 'v1')
          db.run('delete from items where id >= 5')
          await save(db, 'v2')
          // WebKit's file times can be this coarse.
          for (const file of env.directory.files.values()) file.lastModified = 1
          expect((await storage().list()).map(base => base.key)).toEqual(['v2', 'v1'])
          expect(rows(await openDb(), 'select count(*) from items')).toEqual([[5]])
        })

        test('keeps the newest two of a branch without Web Locks', async () => {
        fullSnapshots()
          const unlocked = storage({locks: null})
          const db = register(await unlocked.open(Database))
          fill(db, 10)
          for (const key of ['v1', 'v2', 'v3', 'v4']) {
            db.run(`insert into items (body) values ('${key}')`)
            await saveTo(unlocked, db, key)
          }
          expect((await unlocked.retain()).sort()).toEqual(['v1', 'v2'])
          expect(rows(db, 'select count(*) from items')).toEqual([[14]])
        })

        test('does not delete a base being written without Web Locks', async () => {
          const unlocked = storage({locks: null})
          const db = register(await unlocked.open(Database))
          fill(db, 100)
          await saveTo(unlocked, db, 'v1', {branch: 'g'})
          db.run('delete from items')
          const checkpoint = saveTo(unlocked, db, 'v2')
          while (!(await unlocked.list()).some(base => base.key === 'v2')) await tick()
          expect(await unlocked.retain()).toEqual([])
          expect(await checkpoint).toBe('written')
          expect((await unlocked.head('g')).key).toBe('v2')
        })

        test('leaves no base and the database unchanged when writing fails', async () => {
          const db = await openDb()
          fill(db, 100)
          await save(db, 'v1')
          db.run('delete from items where id >= 10')
          const pages = held(db)
          env.directory.failWrites = true
          await expect(save(db, 'v2')).rejects.toThrow('write failed')
          env.directory.failWrites = false
          expect([...env.directory.files.keys()].sort()).toEqual(['v1', 'v1.json'])
          expect(db.base.key).toBe('v1')
          expect(held(db)).toBe(pages)
          expect(rows(db, 'select count(*) from items')).toEqual([[10]])
          expect(await save(db, 'v2')).toBe('written')
        })
      } else {
        test('deletes bases databases read, which keep reading them', async () => {
        fullSnapshots()
          const a = await openDb()
          fill(a, 1000)
          await save(a, 'v1')
          const b = await openDb('v1')
          b.run('delete from items where id < 10')
          await save(b, 'v2')
          expect(await storage().retain()).toEqual(['v1'])
          // a reads v1 from a fresh fork, whose page cache is empty.
          const fork = keep(a.fork())
          expect(rows(fork, 'select count(*), sum(length(body)) from items'))
            .toEqual([[1000, 500_000]])
          await expect(storage().open(Database, {key: 'v1'}))
            .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
        })
      }
    })
  })
}

describe('Checkpoints in memory', () => {
  test('move the database even when reading the new base back fails', async () => {
    const store = memorySnapshotStore()
    let fail = false
    const flaky = {
      ...store,
      async get(key) {
        if (fail) {
          fail = false
          throw new Error('read failed')
        }
        return store.get(key)
      }
    }
    const storage = new SnapshotStorage(flaky)
    const db = register(await storage.open(Database))
    fill(db, 100)
    await saveTo(storage, db, 'v1')
    db.run('delete from items where id >= 10')
    fail = true
    expect(await saveTo(storage, db, 'v2')).toBe('written')
    expect(snapshotOf(db)).toMatchObject({key: 'v2', branch: ''})
    expect(held(db)).toBe(0)
  })

  test('copy meta in and out', async () => {
    const storage = memorySnapshots()
    const db = register(await storage.open(Database))
    fill(db, 1)
    const meta = {tree: 'a'}
    await saveTo(storage, db, 'v1', {meta})
    meta.tree = 'changed'
    expect((await storage.list())[0].meta).toEqual({tree: 'a'})
  })
})

describe('Forks', () => {
  test('keep the page cache size of an in-memory database', () => {
    const db = keep(new Database())
    db.run('pragma cache_size = -4096')
    expect(rows(keep(db.fork()), 'pragma cache_size')).toEqual([[-4096]])
  })
})

describe('Read-only files', () => {
  test('read bytes and refuse writes', () => {
    const file = readOnlyFile(new Uint8Array([1, 2, 3, 4]))
    const buffer = new Uint8Array(3)
    expect(file.getSize()).toBe(4)
    expect(file.read(buffer, {at: 2})).toBe(2)
    expect([...buffer.subarray(0, 2)]).toEqual([3, 4])
    expect(() => file.write(buffer, {at: 0})).toThrow()
    expect(() => file.truncate(0)).toThrow()
  })

  test('read Blobs in blocks while reads run forward', () => {
    const bytes = new Uint8Array(10_000).map((_, i) => (i * 31) & 255)
    const slices = []
    class CountingBlob extends Blob {
      slice(start, end) {
        slices.push(end - start)
        return super.slice(start, end)
      }
    }
    const file = readOnlyFile(new CountingBlob([bytes]), {blockSize: 1024, blocks: 3})
    const check = (at, length) => {
      const buffer = new Uint8Array(length)
      const read = file.read(buffer, {at})
      const expected = bytes.subarray(at, at + length)
      expect(read).toBe(expected.length)
      expect(buffer.subarray(0, read)).toEqual(expected)
    }
    // Reads in random order read what was asked; a read shortly after the
    // previous one reads its whole block.
    check(5000, 50)
    check(100, 50)
    check(300, 50)
    check(500, 50)
    expect(slices).toEqual([50, 50, 1024])
    // Within, across and past blocks, and past the end
    const next = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff))(5)
    for (let i = 0; i < 500; i++) check(next() % 10_500, 1 + (next() % 3000))
    // A scan reads one block at a time, after its first read.
    slices.length = 0
    for (let at = 0; at < 10_000; at += 256) check(at, 256)
    expect(slices.slice(1).every(length => length === 1024 || length === 784)).toBe(true)
    expect(slices.length).toBeLessThanOrEqual(11)
  })

  test('read Blobs', () => {
    const file = readOnlyFile(new Blob([new Uint8Array([5, 6, 7])]))
    const buffer = new Uint8Array(4)
    expect(file.read(buffer, {at: 1})).toBe(2)
    expect([...buffer.subarray(0, 2)]).toEqual([6, 7])
  })
})

// Random changes, transactions with savepoints and rollbacks, VACUUM (also
// to other page sizes, and incremental), and checkpoints that overlap them,
// so databases move onto new bases also halfway through a transaction:
// compared with the same changes on a plain database, the database and
// every base as of when its checkpoint was called.
describe('Random checkpoints', () => {
  function random(seed) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
  }

  const state = db =>
    JSON.stringify([
      db.exec('select id, hex(b) from t order by id'),
      db.exec('pragma page_count'),
      db.exec('pragma freelist_count')
    ])

  async function run(seed, storage, autoVacuum) {
    const next = random(seed)
    const pick = n => Math.floor(next() * n)
    const db = register(await storage.open(Database))
    const reference = keep(new Database())
    // Statements fail the same way on both, or not at all.
    const run = sql => {
      const errors = [db, reference].map(db => {
        try {
          db.run(sql)
        } catch (error) {
          return error.message
        }
      })
      expect(errors[0]).toBe(errors[1])
    }
    run(`pragma auto_vacuum = ${autoVacuum}`)
    run('create table t (id integer primary key, b blob)')
    // A small cache makes transactions write their pages early.
    run('pragma cache_size = 3')
    let id = 0
    let inTransaction = false
    let savepoints = 0
    const pending = []
    for (let step = 0; step < 100; step++) {
      const x = next()
      if (x < 0.1 && !inTransaction) {
        run('begin')
        inTransaction = true
      } else if (x < 0.17 && inTransaction) {
        run(next() < 0.5 ? 'commit' : 'rollback')
        inTransaction = false
        savepoints = 0
      } else if (x < 0.22 && inTransaction) {
        run(`savepoint s${savepoints++}`)
      } else if (x < 0.26 && inTransaction && savepoints > 0) {
        run(`rollback to s${pick(savepoints)}`)
      } else if (x < 0.45) {
        for (let i = pick(80); i >= 0; i--)
          run(`insert into t values (${id++}, zeroblob(${pick(3000)}) || char(${65 + pick(26)}))`)
      } else if (x < 0.55) {
        const from = pick(id)
        run(`delete from t where id between ${from} and ${from + pick(200)}`)
      } else if (x < 0.6) {
        run(`update t set b = char(${65 + pick(26)}) where id % ${2 + pick(5)} = 0`)
      } else if (x < 0.64 && !inTransaction) {
        if (next() < 0.5) run(`pragma page_size = ${[1024, 2048, 4096, 8192][pick(4)]}`)
        run('vacuum')
      } else if (x < 0.67 && autoVacuum === 2) {
        run(`pragma incremental_vacuum(${pick(50)})`)
      } else if (x < 0.82 && !inTransaction) {
        const key = `k${pending.length}`
        pending.push({key, at: keep(reference.fork()), written: saveTo(storage, db, key)})
      } else {
        for (let i = pick(4); i > 0; i--) await tick()
      }
      expect(state(db)).toBe(state(reference))
    }
    if (inTransaction) run('rollback')
    for (const {key, at, written} of pending) {
      expect(await written).toBe('written')
      expect(state(register(await storage.open(Database, {key})))).toBe(state(at))
    }
    expect(state(db)).toBe(state(reference))
  }

  for (const [variant, {setup}] of Object.entries(variants)) {
    test(`match a plain database in ${variant}`, async () => {
      for (const autoVacuum of [0, 1, 2]) {
        for (let seed = 1; seed <= 4; seed++) {
          await run(seed * 7 + autoVacuum, setup().storage(), autoVacuum)
        }
      }
    }, 120_000)
  }

  test('keep a statement stepping while its database moves', async () => {
    const storage = memorySnapshots()
    const db = register(await storage.open(Database))
    db.run('create table t (id integer primary key, b blob)')
    db.run('begin')
    for (let i = 0; i < 2000; i++) db.run(`insert into t values (${i}, zeroblob(500))`)
    db.run('commit')
    await saveTo(storage, db, 'v1')
    db.run('pragma cache_size = 2')
    db.run('update t set b = zeroblob(400) where id % 3 = 0')
    const checkpoint = saveTo(storage, db, 'v2')
    const stmt = db.prepare('select id, length(b) from t order by id')
    const read = []
    for (let i = 0; i < 10; i++) {
      stmt.step()
      read.push(stmt.get())
    }
    await checkpoint
    expect(snapshotOf(db).key).toBe('v2')
    while (stmt.step()) read.push(stmt.get())
    stmt.free()
    expect(read.length).toBe(2000)
    expect(read.every(([id, length], i) => id === i && length === (i % 3 === 0 ? 400 : 500)))
      .toBe(true)
  })
})
