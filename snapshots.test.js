import {afterEach, beforeAll, beforeEach, describe, expect, test} from 'bun:test'
import {init} from '@alinea/sqlite-wasm'
import {SnapshotStorage, readOnlyFile} from '@alinea/sqlite-wasm/snapshots'
import {MemoryLocks, MemorySnapshotDirectory} from './memory-file-system.js'

// Exercise snapshot storage on an in-memory directory and Web Locks (see
// memory-file-system.js). Storages that share a directory and locks stand
// in for Workers that share OPFS.

let Database
let directory
let locks
const open = []

beforeAll(async () => {
  ;({Database} = await init())
})

beforeEach(() => {
  directory = new MemorySnapshotDirectory()
  locks = new MemoryLocks()
})

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close()
    } catch {}
  }
})

function storage(options = {locks}) {
  return new SnapshotStorage('entries', directory, options)
}

async function openDb(name, from = storage()) {
  return keep(await from.open(Database, name))
}

function keep(db) {
  open.push(db)
  return db
}

function rows(db, sql) {
  return db.exec(sql)[0]?.values ?? []
}

const dump = db => rows(db, 'select id, body from items order by id')
const held = db => Number(rows(db, 'pragma overlay_pages')[0][0])

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

const locked = name =>
  JSON.stringify(['@alinea/sqlite-wasm/snapshots', 'entries', 'read', name])

describe('Opening', () => {
  test('starts an empty database without base files', async () => {
    const db = await openDb()
    expect(rows(db, 'select count(*) from sqlite_schema')).toEqual([[0]])
    expect(db.base).toBeUndefined()
  })

  test('reads pages from the base file and keeps changes in memory', async () => {
    const db = await openDb()
    fill(db, 2000)
    expect(await storage().checkpoint(db, 'v1')).toBe(true)
    const file = directory.files.get('v1').data
    const other = await openDb('v1')
    expect(held(other)).toBe(0)
    expect(rows(other, 'select count(*), sum(length(body)) from items'))
      .toEqual([[2000, 1_000_000]])
    expect(held(other)).toBe(0)
    // Pages read from the file stay in a larger page cache, also in forks.
    expect(rows(other, 'pragma cache_size')).toEqual([[-8192]])
    expect(rows(keep(other.fork()), 'pragma cache_size')).toEqual([[-8192]])
    other.run("update items set body = 'changed' where id < 10")
    expect(held(other)).toBeGreaterThan(0)
    expect(rows(db, "select count(*) from items where body = 'changed'"))
      .toEqual([[0]])
    // The base file is never written.
    expect(directory.files.get('v1').data).toBe(file)
  })

  test('picks the newest base file', async () => {
    const db = await openDb()
    fill(db, 10)
    await storage().checkpoint(db, 'b')
    db.run('delete from items where id >= 5')
    await storage().checkpoint(db, 'a')
    const newest = await openDb()
    expect(rows(newest, 'select count(*) from items')).toEqual([[5]])
    const older = await openDb('b')
    expect(rows(older, 'select count(*) from items')).toEqual([[10]])
  })

  test('skips empty files, which are being written', async () => {
    const db = await openDb()
    fill(db, 10)
    await storage().checkpoint(db, 'v1')
    directory.set('v2', new Uint8Array(0))
    const newest = await openDb()
    expect(rows(newest, 'select count(*) from items')).toEqual([[10]])
    await expect(storage().open(Database, 'v2'))
      .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
  })

  test('fails with SQLITE_CANTOPEN for a missing base file', async () => {
    await expect(storage().open(Database, 'missing'))
      .rejects.toMatchObject({code: 'SQLITE_CANTOPEN'})
  })

  test('fails with SQLITE_CORRUPT for a damaged base file', async () => {
    const db = await openDb()
    fill(db, 1000)
    await storage().checkpoint(db, 'good')
    const good = directory.files.get('good').data
    directory.set('garbage', new Uint8Array(8192).fill(7))
    directory.set('truncated', good.slice(0, good.byteLength / 2))
    const schema = good.slice()
    schema.fill(0xff, 100, 4096)
    directory.set('schema', schema)
    for (const name of ['garbage', 'truncated', 'schema']) {
      await expect(storage().open(Database, name))
        .rejects.toMatchObject({code: 'SQLITE_CORRUPT'})
    }
    // Nothing stays locked or registered.
    expect(locks.held.size).toBe(1)
    // The newest file is kept, damaged or not.
    expect((await storage().cleanup()).sort()).toEqual(['garbage', 'truncated'])
  })
})

describe('Checkpoints', () => {
  test('write the changes, rebase, and match the same changes without snapshots', async () => {
    const db = await openDb()
    const reference = keep(new Database())
    both(db, reference, db => fill(db, 3000))
    expect(await storage().checkpoint(db, 'v1')).toBe(true)
    // Every page is in the base file now.
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
    expect(directory.files.get('v2').data.byteLength)
      .toBeLessThan(directory.files.get('v1').data.byteLength / 5)
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
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(await checkpoint).toBe(true)
    expect(writes).toBeGreaterThan(3)
    // The base holds the state the checkpoint started from, the database
    // everything.
    const reopened = await openDb('v2')
    expect(reopened.export()).toEqual(atCheckpoint.export())
    expect(db.export()).toEqual(reference.export())
    expect(held(db)).toBeGreaterThan(0)
    expect(held(db)).toBeLessThan(writes * 3)
  })

  test('run one at a time per database', async () => {
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
    expect(db.base.name).toBe('v3')
    expect(held(db)).toBe(0)
  })

  test('skip a name that exists, leaving the database as it is', async () => {
    const a = await openDb()
    fill(a, 100)
    await storage().checkpoint(a, 'v1')
    const written = directory.files.get('v1').data
    const b = await openDb('v1')
    b.run('delete from items where id >= 10')
    const pages = held(b)
    expect(await storage().checkpoint(b, 'v1')).toBe(false)
    expect(directory.files.get('v1').data).toBe(written)
    expect(held(b)).toBe(pages)
    expect(rows(b, 'select count(*) from items')).toEqual([[10]])
    expect(rows(await openDb('v1'), 'select count(*) from items')).toEqual([[100]])
  })

  test('write a name once when two databases race for it', async () => {
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
    expect(winner.base.name).toBe('same')
    expect(held(winner)).toBe(0)
  })

  test('leave no file and the database unchanged when writing fails', async () => {
    const db = await openDb()
    fill(db, 100)
    await storage().checkpoint(db, 'v1')
    db.run('delete from items where id >= 10')
    const pages = held(db)
    directory.failWrites = true
    await expect(storage().checkpoint(db, 'v2')).rejects.toThrow('write failed')
    directory.failWrites = false
    expect(directory.files.has('v2')).toBe(false)
    expect(db.base.name).toBe('v1')
    expect(held(db)).toBe(pages)
    expect(rows(db, 'select count(*) from items')).toEqual([[10]])
    expect(await storage().checkpoint(db, 'v2')).toBe(true)
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
    expect(rows(forkOfFork, 'select count(*) from items')).toEqual([[1000]])
    // They hold the lock on v1 between them.
    expect(await storage().cleanup()).toEqual([])
    fork.close()
    expect(await storage().cleanup()).toEqual([])
    forkOfFork.close()
    expect(await storage().cleanup()).toEqual(['v1'])
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
  test('deletes base files nobody reads, except the newest', async () => {
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
    expect([...directory.files.keys()].sort()).toEqual(['v1', 'v3'])
    a.close()
    expect(await storage().cleanup()).toEqual(['v1'])
    b.close()
    expect(await storage().cleanup()).toEqual([])
    expect(rows(await openDb(), 'select count(*) from items')).toEqual([[8]])
  })

  test('does not delete a file while a checkpoint writes it', async () => {
    const db = await openDb()
    fill(db, 100)
    await storage().checkpoint(db, 'v1')
    db.run('delete from items')
    const checkpoint = storage().checkpoint(db, 'v2')
    // Wait until v2 exists, empty, while it is written.
    while (!directory.files.has('v2')) await new Promise(r => setTimeout(r, 0))
    expect(locks.held.has(locked('v2'))).toBe(true)
    expect(await storage().cleanup()).toEqual([])
    await checkpoint
    expect(await storage().cleanup()).toEqual(['v1'])
  })

  test('keeps the newest two without Web Locks', async () => {
    const unlocked = storage({locks: null})
    const db = keep(await unlocked.open(Database))
    fill(db, 10)
    for (const name of ['v1', 'v2', 'v3', 'v4']) {
      db.run(`insert into items (body) values ('${name}')`)
      await unlocked.checkpoint(db, name)
    }
    expect((await unlocked.cleanup()).sort()).toEqual(['v1', 'v2'])
    expect([...directory.files.keys()].sort()).toEqual(['v3', 'v4'])
    expect(rows(db, 'select count(*) from items')).toEqual([[14]])
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
})
