import {afterEach, beforeAll, beforeEach, describe, expect, test} from 'bun:test'
import {init} from '@alinea/sqlite-wasm'
import {
  SnapshotStorage,
  directoryBaseStore,
  indexedDBSnapshotStorage,
  readOnlyFile
} from '@alinea/sqlite-wasm/snapshots'
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb'
import {
  MemoryFileReaderSync,
  MemoryLocks,
  MemorySnapshotDirectory
} from './memory-file-system.js'

// Exercise snapshot storage with bases as files (in an in-memory directory
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
        storage: (options = {locks}) =>
          new SnapshotStorage(directoryBaseStore('entries', directory), options)
      }
    }
  },
  indexeddb: {
    locking: false,
    setup() {
      const indexedDB = new IDBFactory()
      return {
        storage: () =>
          indexedDBSnapshotStorage('entries', {indexedDB, IDBKeyRange})
      }
    }
  }
}

for (const [variant, {locking, setup}] of Object.entries(variants)) {
  describe(`Snapshots in ${variant}`, () => {
    let storage
    let env

    beforeEach(() => {
      env = setup()
      storage = env.storage
    })

    async function openDb(which) {
      return keep(await storage().open(Database, which))
    }

    // Put `data` in base `key` as it is, damaged or not.
    function put(key, data, group = '') {
      return storage().store.write({
        key,
        group,
        meta: {},
        base: data,
        visible: data.byteLength,
        size: data.byteLength,
        chunkSize: 4096,
        pages: [],
        page() {}
      })
    }

    async function content(key) {
      return bytes((await storage().store.get(key)).source)
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
        expect(await storage().checkpoint(db, 'v1')).toBe(true)
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

      test('picks the newest base, of all or of a group, or one by key', async () => {
        const db = await openDb()
        fill(db, 10)
        await storage().checkpoint(db, 'b', {group: 'one'})
        db.run('delete from items where id >= 5')
        await storage().checkpoint(db, 'a', {group: 'two', meta: {tree: 'x'}})
        db.run('delete from items where id >= 3')
        // Inherits the group of the base the database reads.
        await storage().checkpoint(db, 'c')
        const list = await storage().list()
        expect(list.map(({key, group, meta}) => ({key, group, meta}))).toEqual([
          {key: 'c', group: 'two', meta: {}},
          {key: 'a', group: 'two', meta: {tree: 'x'}},
          {key: 'b', group: 'one', meta: {}}
        ])
        expect(list[0].size).toBe((await content('c')).byteLength)
        expect(list[0].createdAt).toBeGreaterThan(list[1].createdAt)
        const count = async which =>
          rows(await openDb(which), 'select count(*) from items')[0][0]
        expect(await count()).toBe(3)
        expect(await count({group: 'one'})).toBe(10)
        expect(await count({group: 'two'})).toBe(3)
        expect(await count({key: 'a'})).toBe(5)
        expect(await count('b')).toBe(10)
        expect(db.base.group).toBe('two')
        // A group without bases starts empty.
        expect((await openDb({group: 'three'})).base).toBeUndefined()
      })

      test('skips empty bases, which are being written', async () => {
        const db = await openDb()
        fill(db, 10)
        await storage().checkpoint(db, 'v1')
        await put('v2', new Uint8Array(0))
        expect(rows(await openDb(), 'select count(*) from items')).toEqual([[10]])
        await expect(storage().open(Database, 'v2'))
          .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
      })

      test('fails with SQLITE_CANTOPEN for a missing base', async () => {
        await expect(storage().open(Database, 'missing'))
          .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
      })

      test('fails with SQLITE_CORRUPT for a damaged base', async () => {
        const db = await openDb()
        fill(db, 1000)
        await storage().checkpoint(db, 'good')
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
        expect((await storage().cleanup()).sort()).toEqual(
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
        expect(await storage().checkpoint(db, 'v1')).toBe(true)
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
        expect(await storage().checkpoint(db, 'v2')).toBe(true)
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
        await storage().checkpoint(db, 'v1')
        both(db, reference, db => {
          db.run('delete from items where id >= 200')
          db.run('vacuum')
        })
        expect(dump(db)).toEqual(dump(reference))
        await storage().checkpoint(db, 'v2')
        expect((await content('v2')).byteLength)
          .toBeLessThan((await content('v1')).byteLength / 5)
        // Shrink below the new base and grow past it before the next one.
        both(db, reference, db => {
          db.run('delete from items where id >= 20')
          db.run('vacuum')
          fill(db, 1000, 700, 10_000)
        })
        expect(db.export()).toEqual(reference.export())
        await storage().checkpoint(db, 'v3')
        expect(db.export()).toEqual(reference.export())
        const reopened = await openDb('v3')
        expect(reopened.export()).toEqual(reference.export())
      })

      test('rebase without losing what changed while the base was written', async () => {
        const db = await openDb()
        const reference = keep(new Database())
        both(db, reference, db => fill(db, 3000))
        await storage().checkpoint(db, 'v1')
        both(db, reference, db => db.run("update items set body = 'before' where id < 1000"))
        const atCheckpoint = keep(reference.fork())
        let done = false
        const checkpoint = storage().checkpoint(db, 'v2').finally(() => (done = true))
        let writes = 0
        while (!done) {
          both(db, reference, db =>
            db.run(`update items set body = 'during ${writes}' where id = ${writes * 7}`)
          )
          writes++
          await tick()
        }
        expect(await checkpoint).toBe(true)
        expect(writes).toBeGreaterThan(1)
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
        const first = storage().checkpoint(db, 'v1')
        db.run('delete from items where id >= 50')
        const second = storage().checkpoint(db, 'v2')
        db.run('delete from items where id >= 20')
        const third = storage().checkpoint(db, 'v3')
        expect(await Promise.all([first, second, third])).toEqual([true, true, true])
        expect(rows(await openDb('v1'), 'select count(*) from items')).toEqual([[100]])
        expect(rows(await openDb('v2'), 'select count(*) from items')).toEqual([[50]])
        expect(rows(await openDb('v3'), 'select count(*) from items')).toEqual([[20]])
        expect(db.base.key).toBe('v3')
        expect(held(db)).toBe(0)
      })

      test('skip a key that exists, leaving the database as it is', async () => {
        const a = await openDb()
        fill(a, 100)
        await storage().checkpoint(a, 'v1')
        const written = await content('v1')
        const b = await openDb('v1')
        b.run('delete from items where id >= 10')
        const pages = held(b)
        expect(await storage().checkpoint(b, 'v1')).toBe(false)
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
          storage().checkpoint(a, 'same'),
          storage().checkpoint(b, 'same')
        ])
        const winner = results[0] ? a : b
        expect([...results].sort()).toEqual([false, true])
        expect(winner.base.key).toBe('same')
        expect(held(winner)).toBe(0)
      })

      test('fail during a write transaction', async () => {
        const db = await openDb()
        fill(db, 10)
        db.run('begin')
        db.run('delete from items')
        await expect(storage().checkpoint(db, 'v1'))
          .rejects.toMatchObject({code: 'SQLITE_BUSY'})
        db.run('commit')
        expect(await storage().checkpoint(db, 'v1')).toBe(true)
      })

      test('store databases loaded into memory', async () => {
        const source = keep(new Database())
        fill(source, 500)
        const db = keep(new Database(source.export()))
        await storage().checkpoint(db, 'loaded')
        expect(held(db)).toBe(0)
        expect(rows(await openDb('loaded'), 'select count(*) from items'))
          .toEqual([[500]])
      })
    })

    describe('Forks', () => {
      test('keep reading their base after the database closes and moves on', async () => {
        const db = await openDb()
        fill(db, 1000)
        await storage().checkpoint(db, 'v1')
        const fork = keep(db.fork())
        const forkOfFork = keep(fork.fork())
        db.run('delete from items')
        await storage().checkpoint(db, 'v2')
        db.close()
        expect(rows(fork, 'select count(*) from items')).toEqual([[1000]])
        if (locking) {
          // They hold the lock on v1 between them.
          expect(await storage().cleanup()).toEqual([])
          fork.close()
          expect(await storage().cleanup()).toEqual([])
          forkOfFork.close()
        }
        expect(await storage().cleanup()).toEqual(['v1'])
        // A fresh fork reads every page from the base again.
        if (!locking) {
          const fresh = keep(forkOfFork.fork())
          expect(rows(fresh, 'select count(*), sum(length(body)) from items'))
            .toEqual([[1000, 500_000]])
        }
      })

      test('can be checkpointed themselves', async () => {
        const db = await openDb()
        fill(db, 100)
        await storage().checkpoint(db, 'v1')
        const fork = keep(db.fork())
        fork.run('delete from items where id >= 30')
        expect(await storage().checkpoint(fork, 'fork')).toBe(true)
        expect(held(fork)).toBe(0)
        expect(rows(await openDb('fork'), 'select count(*) from items')).toEqual([[30]])
        expect(rows(db, 'select count(*) from items')).toEqual([[100]])
      })
    })

    describe('Cleanup', () => {
      test('keeps the newest base of each group', async () => {
        const db = await openDb()
        fill(db, 10)
        for (const key of ['a1', 'a2', 'a3']) {
          db.run(`insert into items (body) values ('${key}')`)
          await storage().checkpoint(db, key, {group: 'a'})
        }
        const other = keep(new Database())
        fill(other, 5)
        await storage().checkpoint(other, 'b1', {group: 'b'})
        other.run('delete from items where id = 1')
        await storage().checkpoint(other, 'b2')
        other.close()
        expect((await storage().cleanup()).sort()).toEqual(['a1', 'a2', 'b1'])
        expect((await storage().list()).map(base => base.key).sort()).toEqual(['a3', 'b2'])
        expect(rows(await openDb({group: 'a'}), 'select count(*) from items')).toEqual([[13]])
      })

      if (locking) {
        test('keeps bases a database reads', async () => {
          const a = await openDb()
          fill(a, 10)
          await storage().checkpoint(a, 'v1')
          const b = await openDb('v1')
          b.run('delete from items where id = 1')
          await storage().checkpoint(b, 'v2')
          b.run('delete from items where id = 2')
          await storage().checkpoint(b, 'v3')
          // a reads v1, b reads v3, which is newest.
          expect(await storage().cleanup()).toEqual(['v2'])
          a.close()
          expect(await storage().cleanup()).toEqual(['v1'])
          b.close()
          expect(await storage().cleanup()).toEqual([])
          expect(rows(await openDb(), 'select count(*) from items')).toEqual([[8]])
        })

        test('does not delete a base while a checkpoint writes it', async () => {
          const db = await openDb()
          fill(db, 100)
          await storage().checkpoint(db, 'v1')
          db.run('delete from items')
          const checkpoint = storage().checkpoint(db, 'v2')
          // Wait until v2 exists, empty, while it is written.
          while (!(await storage().list()).some(base => base.key === 'v2')) await tick()
          expect(await storage().cleanup()).toEqual([])
          await checkpoint
          expect(await storage().cleanup()).toEqual(['v1'])
        })

        test('keeps the newest two of a group without Web Locks', async () => {
          const unlocked = storage({locks: null})
          const db = keep(await unlocked.open(Database))
          fill(db, 10)
          for (const key of ['v1', 'v2', 'v3', 'v4']) {
            db.run(`insert into items (body) values ('${key}')`)
            await unlocked.checkpoint(db, key)
          }
          expect((await unlocked.cleanup()).sort()).toEqual(['v1', 'v2'])
          expect(rows(db, 'select count(*) from items')).toEqual([[14]])
        })

        test('leaves no base and the database unchanged when writing fails', async () => {
          const db = await openDb()
          fill(db, 100)
          await storage().checkpoint(db, 'v1')
          db.run('delete from items where id >= 10')
          const pages = held(db)
          env.directory.failWrites = true
          await expect(storage().checkpoint(db, 'v2')).rejects.toThrow('write failed')
          env.directory.failWrites = false
          expect([...env.directory.files.keys()].sort()).toEqual(['v1', 'v1.json'])
          expect(db.base.key).toBe('v1')
          expect(held(db)).toBe(pages)
          expect(rows(db, 'select count(*) from items')).toEqual([[10]])
          expect(await storage().checkpoint(db, 'v2')).toBe(true)
        })
      } else {
        test('deletes bases databases read, which keep reading them', async () => {
          const a = await openDb()
          fill(a, 1000)
          await storage().checkpoint(a, 'v1')
          const b = await openDb('v1')
          b.run('delete from items where id < 10')
          await storage().checkpoint(b, 'v2')
          expect(await storage().cleanup()).toEqual(['v1'])
          // a reads v1 from a fresh fork, whose page cache is empty.
          const fork = keep(a.fork())
          expect(rows(fork, 'select count(*), sum(length(body)) from items'))
            .toEqual([[1000, 500_000]])
          await expect(storage().open(Database, 'v1'))
            .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
        })
      }
    })
  })
}

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

  test('read Blobs', () => {
    const file = readOnlyFile(new Blob([new Uint8Array([5, 6, 7])]))
    const buffer = new Uint8Array(4)
    expect(file.read(buffer, {at: 1})).toBe(2)
    expect([...buffer.subarray(0, 2)]).toEqual([6, 7])
  })
})
