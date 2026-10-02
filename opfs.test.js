import {afterEach, beforeAll, beforeEach, describe, expect, test} from 'bun:test'
import {init} from '@alinea/sqlite-wasm'
import {fileStorage} from '@alinea/sqlite-wasm/opfs'

// Exercise file storage on an in-memory file system with the same
// synchronous access as OPFS, which Bun does not have. `failWrites` makes
// writes to a file fail, to interrupt a commit halfway.

class MemoryFile {
  data = new Uint8Array(0)
  size = 0
  open = false
  failWrites = false

  read(buffer, {at}) {
    const n = Math.max(0, Math.min(buffer.length, this.size - at))
    buffer.set(this.data.subarray(at, at + n))
    return n
  }

  write(buffer, {at}) {
    if (this.failWrites) throw new Error('write failed')
    const end = at + buffer.length
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2))
      grown.set(this.data.subarray(0, this.size))
      this.data = grown
    }
    if (at > this.size) this.data.fill(0, this.size, at)
    this.data.set(buffer, at)
    this.size = Math.max(this.size, end)
    return buffer.length
  }

  truncate(size) {
    if (size < this.size) this.data.fill(0, size, this.size)
    this.size = size
  }

  getSize() {
    return this.size
  }

  flush() {}

  close() {
    this.open = false
  }

  bytes() {
    return this.data.slice(0, this.size)
  }
}

class MemoryFileSystem {
  files = new Map()

  file(name) {
    let file = this.files.get(name)
    if (!file) this.files.set(name, (file = new MemoryFile()))
    return file
  }

  async open(name) {
    const file = this.file(name)
    if (file.open) throw new Error(`${name} is open`)
    file.open = true
    return file
  }

  async remove(name) {
    this.files.delete(name)
  }
}

let Database
let fs
const open = []

beforeAll(async () => {
  ;({Database} = await init())
})

// Every test starts from an empty file system.
beforeEach(() => {
  fs = new MemoryFileSystem()
})

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close()
    } catch {}
  }
})

async function sync(name = 'notes.sqlite3') {
  const db = await Database.sync(fileStorage(name, fs))
  open.push(db)
  return db
}

function rows(db, sql) {
  return db.exec(sql)[0]?.values ?? []
}

function fill(db, count, size = 500) {
  db.run('create table if not exists items (id integer primary key, body text)')
  db.run('begin')
  const insert = db.prepare('insert into items (body) values (?)')
  for (let i = 0; i < count; i++) insert.run([`${i} `.padEnd(size, 'x')])
  insert.free()
  db.run('commit')
}

describe('File storage', () => {
  test('stores every commit in the file and loads it again', async () => {
    const db = await sync()
    db.run('create table notes (text)')
    db.run('insert into notes values (?)', ['stored'])
    const file = fs.file('notes.sqlite3')
    expect(new TextDecoder().decode(file.bytes().subarray(0, 15)))
      .toBe('SQLite format 3')
    // Stored before the commit returned: a copy of the file has the row.
    const copy = new Database(file.bytes())
    expect(rows(copy, 'select text from notes')).toEqual([['stored']])
    copy.close()
    db.close()
    const again = await sync()
    expect(rows(again, 'select text from notes')).toEqual([['stored']])
  })

  test('keeps no committed pages in memory', async () => {
    const db = await sync()
    fill(db, 2000)
    expect(rows(db, 'pragma overlay_pages')).toEqual([['0']])
    expect(fs.file('notes.sqlite3').size).toBeGreaterThan(1_000_000)
    expect(rows(db, 'select count(*), sum(length(body)) from items'))
      .toEqual([[2000, 1_000_000]])
    db.run("update items set body = 'changed' where id <= 10")
    expect(rows(db, 'pragma overlay_pages')).toEqual([['0']])
    expect(rows(db, "select count(*) from items where body = 'changed'"))
      .toEqual([[10]])
  })

  test('does not store rolled back changes', async () => {
    const db = await sync()
    fill(db, 10)
    db.run('begin')
    db.run('delete from items')
    db.run('rollback')
    db.close()
    const again = await sync()
    expect(rows(again, 'select count(*) from items')).toEqual([[10]])
  })

  test('shrinks the file when the database shrinks', async () => {
    const db = await sync()
    fill(db, 2000)
    const before = fs.file('notes.sqlite3').size
    db.run('delete from items where id > 100')
    db.run('vacuum')
    const after = fs.file('notes.sqlite3').size
    expect(after).toBeLessThan(before / 5)
    expect(rows(db, 'select count(*) from items')).toEqual([[100]])
    db.close()
    const again = await sync()
    expect(rows(again, 'select count(*), max(id) from items')).toEqual([[100, 100]])
  })

  test('flushes during a transaction', async () => {
    const db = await sync()
    fill(db, 10)
    db.run('begin')
    db.run('delete from items')
    await db.flush()
    db.run('commit')
    await db.flush()
    expect(rows(db, 'select count(*) from items')).toEqual([[0]])
  })

  test('exports the stored database', async () => {
    const db = await sync()
    fill(db, 300)
    const copy = new Database(db.export())
    expect(rows(copy, 'select count(*) from items')).toEqual([[300]])
    copy.close()
  })
})

describe('Forks of a stored database', () => {
  test('keep their snapshot while the stored database changes', async () => {
    const db = await sync()
    fill(db, 1000)
    const fork = db.fork()
    open.push(fork)
    db.run("update items set body = 'changed'")
    db.run('delete from items where id > 500')
    db.run('vacuum')
    expect(rows(fork, "select count(*), sum(body = 'changed') from items"))
      .toEqual([[1000, 0]])
    expect(rows(db, "select count(*), sum(body = 'changed') from items"))
      .toEqual([[500, 500]])
    fork.run("insert into items (body) values ('fork')")
    expect(rows(db, "select count(*) from items where body = 'fork'"))
      .toEqual([[0]])
  })

  test('stay readable after the stored database closes', async () => {
    const db = await sync()
    fill(db, 1000)
    const fork = db.fork()
    open.push(fork)
    db.close()
    // The file can change or go away now.
    await fileStorage('notes.sqlite3', fs).delete()
    expect(rows(fork, 'select count(*), sum(length(body)) from items'))
      .toEqual([[1000, 500_000]])
  })
})

describe('Interrupted commits', () => {
  test('are finished from the journal when the file was not written', async () => {
    const db = await sync()
    fill(db, 100)
    fs.file('notes.sqlite3').failWrites = true
    db.run("update items set body = 'committed' where id <= 50")
    // The commit stands, but is not stored; flush reports it.
    expect(rows(db, "select count(*) from items where body = 'committed'"))
      .toEqual([[50]])
    await expect(db.flush()).rejects.toMatchObject({code: 'SQLITE_IOERR'})
    expect(fs.file('notes.sqlite3-journal').size).toBeGreaterThan(0)
    db.close()
    fs.file('notes.sqlite3').failWrites = false
    // Opening replays the complete journal.
    const again = await sync()
    expect(rows(again, "select count(*) from items where body = 'committed'"))
      .toEqual([[50]])
    // Replayed once: its header is cleared.
    const journal = fs.file('notes.sqlite3-journal').bytes()
    expect(journal.subarray(0, 8).every(byte => byte === 0)).toBe(true)
  })

  test('are left out when the journal is incomplete', async () => {
    const db = await sync()
    fill(db, 100)
    fs.file('notes.sqlite3-journal').failWrites = true
    db.run("update items set body = 'lost' where id <= 50")
    db.close()
    fs.file('notes.sqlite3-journal').failWrites = false
    const again = await sync()
    expect(rows(again, "select count(*) from items where body = 'lost'"))
      .toEqual([[0]])
    expect(rows(again, 'select count(*) from items')).toEqual([[100]])
  })

  test('are stored by flush once writing works again', async () => {
    const db = await sync()
    fill(db, 100)
    const file = fs.file('notes.sqlite3')
    file.failWrites = true
    db.run('delete from items where id > 10')
    await expect(db.flush()).rejects.toMatchObject({code: 'SQLITE_IOERR'})
    file.failWrites = false
    await db.flush()
    const copy = new Database(file.bytes())
    expect(rows(copy, 'select count(*) from items')).toEqual([[10]])
    copy.close()
  })
})

describe('One database per file', () => {
  test('fails with SQLITE_BUSY while the file is in use', async () => {
    const storage = fileStorage('notes.sqlite3', fs)
    await sync()
    await expect(Database.sync(storage)).rejects.toMatchObject({code: 'SQLITE_BUSY'})
    await expect(storage.delete()).rejects.toMatchObject({code: 'SQLITE_BUSY'})
  })

  test('deletes the file and its journal once closed', async () => {
    const db = await sync()
    fill(db, 10)
    db.close()
    await fileStorage('notes.sqlite3', fs).delete()
    expect([...fs.files.keys()]).toEqual([])
  })

  test('keeps databases in different files apart', async () => {
    const a = await sync('a.sqlite3')
    const b = await sync('b.sqlite3')
    fill(a, 5)
    fill(b, 7)
    expect(rows(a, 'select count(*) from items')).toEqual([[5]])
    expect(rows(b, 'select count(*) from items')).toEqual([[7]])
  })

  test('cannot attach a database in memory', async () => {
    const db = new Database()
    open.push(db)
    await expect(db.attach(fileStorage('notes.sqlite3', fs)))
      .rejects.toMatchObject({code: 'SQLITE_MISUSE'})
  })
})
