// Tests the prebuilt overlay extension for this platform with bun:sqlite and
// node:sqlite. Runs under both `bun test` and `node --test`. Build first.
import {after, before, describe, test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {overlayExtension} from '@alinea/sqlite-wasm/native'

interface Db {
  exec(sql: string): void
  get(sql: string): Record<string, any> | undefined
  all(sql: string): Array<Record<string, any>>
  close(): void
}

const runtime = 'Bun' in globalThis ? 'bun' : 'node'
const open: (path: string, loadExtension?: boolean) => Db = await (async () => {
  if (runtime === 'bun') {
    const {Database, constants} = await import('bun:sqlite')
    // Bun's own SQLite build only parses file: URIs when asked to.
    const flags =
      constants.SQLITE_OPEN_READWRITE |
      constants.SQLITE_OPEN_CREATE |
      constants.SQLITE_OPEN_URI
    // Apple's system SQLite, which bun uses by default, cannot load extensions.
    if (process.platform === 'darwin') {
      const candidates = [
        process.env.SQLITE_LIB,
        '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
        '/usr/local/opt/sqlite/lib/libsqlite3.dylib'
      ]
      const lib = candidates.find(path => path && statSync(path, {throwIfNoEntry: false}))
      if (!lib) throw new Error('Install SQLite with Homebrew or set SQLITE_LIB')
      Database.setCustomSQLite(lib)
    }
    return (path, loadExtension) => {
      const db = new Database(path, flags)
      if (loadExtension) db.loadExtension(overlayExtension())
      return {
        exec: sql => void db.exec(sql),
        get: sql => (db.query(sql).get() as Record<string, any>) ?? undefined,
        all: sql => db.query(sql).all() as Array<Record<string, any>>,
        close: () => db.close()
      }
    }
  }
  const {DatabaseSync} = await import('node:sqlite')
  return (path, loadExtension) => {
    const db = new DatabaseSync(path, {allowExtension: !!loadExtension})
    if (loadExtension) db.loadExtension(overlayExtension())
    return {
      exec: sql => db.exec(sql),
      get: sql => {
        const row = db.prepare(sql).get()
        return row && {...row}
      },
      all: sql => db.prepare(sql).all().map(row => ({...row})),
      close: () => db.close()
    }
  }
})()

const dir = mkdtempSync(join(tmpdir(), 'sqlite-overlay-'))
const basePath = join(dir, 'base.db')
const walBasePath = join(dir, 'wal-base.db')
const exportPath = join(dir, 'export.db')
const uri = (path: string) => pathToFileURL(path).href
const base = `${uri(basePath)}?vfs=overlay`

const hash = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
const count = (db: Db, where = '1') =>
  db.get(`select count(*) as n from t where ${where}`)!.n
const pragma = (db: Db, name: string) => Object.values(db.get(`pragma ${name}`)!)[0]
const insertRows = (db: Db, n: number, tag: string) =>
  db.exec(`
    with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ${n})
    insert into t (tag, payload) select '${tag}', randomblob(100) from seq
  `)

let baseHash: string
let baseStat: {mtimeMs: number; size: number}
let walBaseHash: string

before(() => {
  const db = open(basePath)
  db.exec('create table t (id integer primary key, tag text, payload blob)')
  insertRows(db, 1000, 'base')
  db.close()

  const wal = open(walBasePath)
  wal.exec('pragma journal_mode = wal')
  wal.exec('create table t (id integer primary key, tag text, payload blob)')
  insertRows(wal, 1000, 'base')
  wal.close()

  baseHash = hash(basePath)
  baseStat = statSync(basePath)
  walBaseHash = hash(walBasePath)
  // Registers the VFS for the whole process.
  open(':memory:', true).close()
})

after(() => rmSync(dir, {recursive: true, force: true}))

describe(`native overlay extension (${runtime})`, () => {
  test('private overlays are isolated from each other', () => {
    const a = open(base)
    const b = open(base)
    insertRows(a, 100, 'a')
    assert.equal(count(a), 1100)
    assert.equal(count(b), 1000)
    a.close()
    b.close()
  })

  test('changes are discarded when the last connection closes', () => {
    const a = open(`${base}&overlay=tmp`)
    insertRows(a, 10, 'tmp')
    a.close()
    const again = open(`${base}&overlay=tmp`)
    assert.equal(count(again), 1000)
    again.close()
  })

  test('named overlays are shared between connections', () => {
    const a1 = open(`${base}&overlay=A`)
    const a2 = open(`${base}&overlay=A`)
    const b = open(`${base}&overlay=B`)
    insertRows(a1, 100, 'a')
    assert.equal(count(a2), 1100)
    assert.equal(count(b), 1000)
    a2.exec("delete from t where tag = 'a' and id % 2 = 0")
    assert.equal(count(a1), 1050)
    a1.close()
    a2.close()
    b.close()
  })

  test('writers on a shared overlay respect locks', () => {
    const w = open(`${base}&overlay=locks`)
    const r = open(`${base}&overlay=locks`)
    r.exec('begin')
    assert.equal(count(r), 1000)
    w.exec('begin')
    insertRows(w, 1, 'w')
    assert.throws(() => w.exec('commit'), /locked|busy/i)
    assert.equal(count(r), 1000)
    r.exec('commit')
    w.exec('commit')
    assert.equal(count(r), 1001)
    w.close()
    r.close()
  })

  test('overlay on overlay: from= snapshots the source', () => {
    const a = open(`${base}&overlay=A`)
    insertRows(a, 100, 'a')

    const c = open(`${base}&overlay=C&from=A`)
    assert.equal(count(c), 1100)
    insertRows(c, 50, 'c')
    assert.equal(count(c), 1150)
    assert.equal(count(a), 1100, "A does not see C's rows")

    insertRows(a, 7, 'a-later')
    assert.equal(count(a), 1107)
    assert.equal(count(c), 1150, "C does not see A's later rows")

    // C keeps its snapshot after A is gone.
    a.close()
    assert.deepEqual(
      c.all('select tag, count(*) as n from t group by tag order by tag'),
      [
        {tag: 'a', n: 100},
        {tag: 'base', n: 1000},
        {tag: 'c', n: 50}
      ]
    )

    // Deeper stacks work the same way.
    const d = open(`${base}&overlay=D&from=C`)
    d.exec("update t set tag = 'd' where tag = 'c'")
    assert.equal(count(c, "tag = 'd'"), 0)
    assert.equal(count(d, "tag = 'd'"), 50)
    assert.equal(pragma(c, 'integrity_check'), 'ok')
    assert.equal(pragma(d, 'integrity_check'), 'ok')
    c.close()
    d.close()
  })

  test('schema changes, bulk writes, rollback and vacuum', () => {
    const db = open(base)
    db.exec('create table u (k text primary key, v blob)')
    db.exec('create index t_tag on t (tag)')
    insertRows(db, 5000, 'bulk')
    db.exec("delete from t where tag = 'base' and id < 500")
    assert.equal(count(db), 5501)

    db.exec('begin')
    db.exec('delete from t')
    assert.equal(count(db), 0)
    db.exec('rollback')
    assert.equal(count(db), 5501)

    db.exec("delete from t where tag = 'bulk'")
    db.exec('vacuum')
    assert.equal(count(db), 501)
    assert.equal(pragma(db, 'integrity_check'), 'ok')
    db.close()
  })

  test('memory use tracks the changed pages only', () => {
    const db = open(base)
    const pages = () => Number(pragma(db, 'overlay_pages'))
    assert.equal(pages(), 0)
    db.exec("update t set tag = 'x' where id = 500")
    assert.ok(Number(pragma(db, 'page_count')) > 30)
    assert.ok(pages() <= 3, `${pages()} pages in memory`)
    db.close()
  })

  test('WAL-mode base is opened as a rollback database', () => {
    const db = open(`${uri(walBasePath)}?vfs=overlay`)
    insertRows(db, 10, 'a')
    assert.equal(count(db), 1010)
    assert.equal(pragma(db, 'integrity_check'), 'ok')
    db.close()
  })

  test('VACUUM INTO exports an overlay through another vfs', () => {
    const db = open(base)
    insertRows(db, 5, 'exported')
    const vfs = process.platform === 'win32' ? 'win32' : 'unix'
    db.exec(`vacuum into '${uri(exportPath)}?vfs=${vfs}'`)
    db.close()
    const out = open(exportPath)
    assert.equal(count(out), 1005)
    out.close()
  })

  test('open errors', () => {
    assert.throws(() => open(`${uri(join(dir, 'missing.db'))}?vfs=overlay`))
    assert.throws(() => open(`${base}&overlay=X&from=nope`))
    const a = open(`${base}&overlay=exists`)
    assert.throws(() => open(`${base}&overlay=exists&from=exists`))
    assert.throws(() => open(`${uri(walBasePath)}?vfs=overlay&overlay=exists`))
    a.close()
  })

  test('base files are never modified', () => {
    assert.equal(hash(basePath), baseHash)
    assert.equal(hash(walBasePath), walBaseHash)
    const stat = statSync(basePath)
    assert.equal(stat.mtimeMs, baseStat.mtimeMs)
    assert.equal(stat.size, baseStat.size)
    assert.deepEqual(readdirSync(dir).sort(), [
      'base.db',
      'export.db',
      'wal-base.db'
    ])
  })
})
