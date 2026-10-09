import {afterEach, beforeAll, describe, expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {init} from '@alinea/sqlite-wasm'
import {readOnlyFileAt} from '@alinea/sqlite-wasm/file'
import {openOverlay} from '@alinea/sqlite-wasm/snapshots'

// Overlays over files of the file system, as Node and Bun open a generated
// database without loading it into memory.

let Database
let dir
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
  if (dir) rmSync(dir, {recursive: true, force: true})
  dir = undefined
})

const keep = db => (open.push(db), db)
const rows = (db, sql) => db.exec(sql)[0]?.values ?? []

// A database file of `count` rows, and its path
function databaseFile(count = 2000, name = 'generated.db') {
  dir ??= mkdtempSync(join(tmpdir(), 'sqlite-wasm-file-'))
  const source = new Database()
  source.run('create table items (id integer primary key, body text)')
  source.run('begin')
  for (let i = 0; i < count; i++)
    source.run('insert into items values (?, ?)', [i, `${i} `.padEnd(500, 'x')])
  source.run('commit')
  const path = join(dir, name)
  writeFileSync(path, source.export())
  source.close()
  return path
}

// A file that counts its reads and closes
function counted(path) {
  const file = readOnlyFileAt(path)
  const counts = {reads: 0, closed: 0}
  return {
    counts,
    file: {
      ...file,
      read(buffer, options) {
        counts.reads++
        return file.read(buffer, options)
      },
      close() {
        counts.closed++
        file.close()
      }
    }
  }
}

describe('Overlays of files', () => {
  test('read pages as needed and keep changes in memory', () => {
    const path = databaseFile()
    const before = readFileSync(path)
    const {file, counts} = counted(path)
    const db = keep(openOverlay(Database, file))
    expect(rows(db, 'select body from items where id = 7')[0][0]).toStartWith('7 ')
    // A point lookup reads a few pages, not the whole file.
    expect(counts.reads).toBeLessThan(10)
    db.run("update items set body = 'changed' where id < 100")
    db.run('insert into items values (5000, ?)', ['new'])
    expect(rows(db, "select count(*) from items where body = 'changed'")).toEqual([[100]])
    expect(rows(db, 'select count(*) from items')).toEqual([[2001]])
    expect(readFileSync(path)).toEqual(before)
  })

  test('fork cheaply, and close the file once all are closed', () => {
    const {file, counts} = counted(databaseFile())
    const db = openOverlay(Database, file)
    db.run('delete from items where id >= 1000')
    const fork = db.fork()
    fork.run('delete from items where id >= 10')
    expect(rows(db, 'select count(*) from items')).toEqual([[1000]])
    expect(rows(fork, 'select count(*) from items')).toEqual([[10]])
    db.close()
    expect(counts.closed).toBe(0)
    expect(rows(fork, 'select count(*), sum(length(body)) from items'))
      .toEqual([[10, 5000]])
    fork.close()
    expect(counts.closed).toBe(1)
  })

  test('fail to read a file written in place, but read on from a replaced one', () => {
    const path = databaseFile()
    const db = keep(openOverlay(Database, readOnlyFileAt(path)))
    expect(rows(db, 'select count(*) from items')).toEqual([[2000]])
    // Replaced by a rename: the open file is still the old one.
    const next = databaseFile(10, 'next.db')
    renameSync(next, path)
    const fork = keep(db.fork())
    expect(rows(fork, 'select count(*), sum(length(body)) from items'))
      .toEqual([[2000, 1_000_000]])
    // Written in place: reads fail instead of mixing old and new pages.
    const other = keep(openOverlay(Database, readOnlyFileAt(path)))
    writeFileSync(path, readFileSync(path).fill(1, 8192))
    expect(() => rows(keep(other.fork()), 'select sum(length(body)) from items'))
      .toThrow()
  })

  test('refuse a file that is not a database, and close it', () => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-wasm-file-'))
    const path = join(dir, 'garbage')
    writeFileSync(path, new Uint8Array(8192).fill(7))
    const {file, counts} = counted(path)
    expect(() => openOverlay(Database, file)).toThrow(
      expect.objectContaining({code: 'SQLITE_CORRUPT'})
    )
    expect(counts.closed).toBe(1)
  })

  test('close a file whose size cannot be read', () => {
    let closed = 0
    const file = {
      read: () => 0,
      getSize() {
        throw new Error('gone')
      },
      write() {},
      truncate() {},
      flush() {},
      close: () => closed++
    }
    expect(() => openOverlay(Database, file)).toThrow('gone')
    expect(closed).toBe(1)
  })

  test('open bytes and Blobs too', () => {
    const bytes = readFileSync(databaseFile(50))
    const db = keep(openOverlay(Database, new Uint8Array(bytes)))
    expect(rows(db, 'select count(*) from items')).toEqual([[50]])
    expect(() => readOnlyFileAt(join(dir, 'missing'))).toThrow()
  })
})
