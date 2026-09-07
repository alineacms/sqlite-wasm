import {afterEach, beforeAll, beforeEach, describe, expect, test} from 'bun:test'
import initBase64, {init} from '@alinea/sqlite-wasm'
import initWasm from '@alinea/sqlite-wasm/init-wasm.js'
import manifest from './package.json'

// Exercise the published artifacts, not the TypeScript source. Build first.
describe('package artifacts', () => {
  test('ships every entry point and its declarations', async () => {
    const entries = new Set(Object.values(manifest.exports['.']))
    for (const entry of entries) {
      expect(await Bun.file(new URL(entry, import.meta.url)).exists()).toBe(true)
      expect(
        await Bun.file(new URL(entry.replace(/\.js$/, '.d.ts'), import.meta.url))
          .exists()
      ).toBe(true)
    }
    expect(await Bun.file(new URL(manifest.types, import.meta.url)).exists())
      .toBe(true)
  })

  test('ships a valid standalone Wasm binary', async () => {
    const bytes = await Bun.file(
      new URL('./dist/sqlite3-emscripten.wasm', import.meta.url)
    ).arrayBuffer()
    expect(WebAssembly.validate(bytes)).toBe(true)
  })

  test('exports the same default and named Base64 initializer', () => {
    expect(initBase64).toBe(init)
  })
})

for (const [name, initialize] of [
  ['Base64 package entry', init],
  ['standalone Wasm entry', initWasm]
]) {
  describe(name, () => {
    let Database
    let db

    beforeAll(async () => {
      ;({Database} = await initialize())
    })

    beforeEach(() => {
      db = new Database()
    })

    afterEach(() => {
      db?.close()
    })

    test('builds the pinned SQLite version', () => {
      expect(db.exec('select sqlite_version()')[0].values).toEqual([['3.53.4']])
    })

    test('returns columns and rows for multiple SQL statements', () => {
      expect(db.exec('select 6 * 7 as answer; select 1 as first, 2 as second'))
        .toEqual([
          {columns: ['answer'], values: [[42]]},
          {columns: ['first', 'second'], values: [[1, 2]]}
        ])
      expect(db.exec('select 1 where 0')).toEqual([])
    })

    test('binds positional values including Unicode, numbers, blobs and null', () => {
      const blob = new Uint8Array([0, 1, 127, 255])
      const stmt = db.prepare('select ? as text, ? as integer, ? as real, ? as blob, ? as empty')
      try {
        expect(stmt.get(['Unicode ✓ 日本語 🎉', 2 ** 40, 1.25, blob, null]))
          .toEqual(['Unicode ✓ 日本語 🎉', 2 ** 40, 1.25, blob, null])
      } finally {
        stmt.free()
      }
    })

    test('reuses prepared statements with named bindings', () => {
      db.run('create table items (id integer primary key, title text)')
      const insert = db.prepare('insert into items values ($id, $title)')
      try {
        insert.run({$id: 1, $title: 'first'})
        insert.run({$id: 2, $title: 'second'})
      } finally {
        insert.free()
      }
      const query = db.prepare('select title from items where id = :id')
      try {
        expect(query.getAsObject({':id': 2})).toEqual({title: 'second'})
        expect(query.step()).toBe(false)
        expect(query.getAsObject({':id': 1})).toEqual({title: 'first'})
      } finally {
        query.free()
      }
    })

    test('supports JSON extraction and table-valued JSON functions', () => {
      expect(db.exec(`select json_extract('{"value":42}', '$.value')`)[0].values)
        .toEqual([[42]])
      expect(db.exec(`select value from json_each('[1,2,3]') order by key`)[0].values)
        .toEqual([[1], [2], [3]])
    })

    test('supports FTS5 indexing, querying and updates', () => {
      db.run('create virtual table pages using fts5(title, body)')
      db.run('insert into pages values (?, ?)', ['SQLite', 'full text search'])
      db.run('insert into pages values (?, ?)', ['Other', 'unrelated content'])
      expect(db.exec("select title from pages where pages match 'search'")[0].values)
        .toEqual([['SQLite']])
      db.run("update pages set body = 'updated content' where title = 'SQLite'")
      expect(db.exec("select title from pages where pages match 'search'"))
        .toEqual([])
      expect(db.exec("select title from pages where pages match 'updated'")[0].values)
        .toEqual([['SQLite']])
    })

    test('commits and rolls back transactions', () => {
      db.run('create table items (value text)')
      db.run('begin').run("insert into items values ('kept')").run('commit')
      db.run('begin').run("insert into items values ('discarded')").run('rollback')
      expect(db.exec('select * from items')[0].values).toEqual([['kept']])
    })

    test('reports modified rows and recovers after SQL errors', () => {
      db.run('create table items (id integer primary key)')
      db.run('insert into items values (1), (2)')
      expect(db.getRowsModified()).toBe(2)
      expect(() => db.run('insert into items values (1)')).toThrow(/UNIQUE/)
      expect(() => db.exec('select * from missing_table')).toThrow(/no such table/)
      db.run('delete from items where id = 2')
      expect(db.getRowsModified()).toBe(1)
      expect(db.exec('select * from items')[0].values).toEqual([[1]])
    })

    test('registers and replaces JavaScript SQL functions', () => {
      db.create_function('twice', value => value * 2)
      expect(db.exec('select twice(21)')[0].values).toEqual([[42]])
      db.create_function('twice', value => value * 3)
      expect(db.exec('select twice(21)')[0].values).toEqual([[63]])
      db.create_function('greet', value => `Hello ${value} ✓`)
      expect(db.exec('select greet(?)', ['世界'])[0].values)
        .toEqual([['Hello 世界 ✓']])
    })

    test('exports and restores writable databases, including offset byte views', () => {
      db.run('create table items (value text)')
      db.run('insert into items values (?)', ['Unicode ✓'])
      const bytes = db.export()
      expect(new TextDecoder().decode(bytes.subarray(0, 16)))
        .toBe('SQLite format 3\0')
      const padded = new Uint8Array(bytes.length + 32)
      padded.set(bytes, 16)
      const restored = new Database(padded.subarray(16, 16 + bytes.length))
      let reexported
      try {
        expect(restored.exec('select * from items')[0].values).toEqual([['Unicode ✓']])
        restored.run("insert into items values ('second')")
        reexported = restored.export()
      } finally {
        restored.close()
      }
      const roundTripped = new Database(reexported)
      try {
        expect(roundTripped.exec('select * from items order by rowid')[0].values)
          .toEqual([['Unicode ✓'], ['second']])
      } finally {
        roundTripped.close()
      }
      expect(db.exec('select count(*) from items')[0].values).toEqual([[1]])
    })

    test('closes outstanding statements and rejects use after close', () => {
      const stmt = db.prepare('select 1')
      const closed = db
      db = undefined
      closed.close()
      expect(() => stmt.step()).toThrow('Statement closed')
      expect(() => closed.run('select 1')).toThrow('Database closed')
      expect(() => closed.exec('select 1')).toThrow('Database closed')
      expect(() => closed.export()).toThrow('Database closed')
    })

    test.each([
      ['date/time functions', "select date('now')"],
      ['window functions', 'select row_number() over ()'],
      ['triggers', 'create trigger items_insert after insert on items begin select 1; end'],
      ['ATTACH', "attach ':memory:' as extra"],
      ['VACUUM', 'vacuum'],
      ['EXPLAIN', 'explain select 1'],
      ['views', 'create view item_values as select value from items']
    ])('intentionally omits %s', (_feature, sql) => {
      db.run('create table items (value text)')
      expect(() => db.exec(sql)).toThrow()
      expect(db.exec('select 1')[0].values).toEqual([[1]])
    })
  })
}
