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

    test('keeps blobs returned by get stable after statement and database activity', () => {
      const expected = new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255])
      db.run('create table blobs (value blob)')
      db.run('insert into blobs values (?), (?)', [
        expected,
        new Uint8Array(expected.length).fill(42)
      ])

      const stmt = db.prepare('select value from blobs order by rowid')
      expect(stmt.step()).toBe(true)
      const value = stmt.get()[0]
      expect(value).toEqual(expected)

      expect(stmt.step()).toBe(true)
      expect(value).toEqual(expected)
      stmt.reset()
      expect(value).toEqual(expected)
      stmt.free()
      expect(value).toEqual(expected)
      db.run('select randomblob(1048576)')
      expect(value).toEqual(expected)
    })

    test('keeps blobs returned by getAsObject stable without a second copy', () => {
      const expected = new Uint8Array([255, 254, 128, 127, 3, 2, 1, 0])
      db.run('create table blobs (value blob)')
      db.run('insert into blobs values (?), (?)', [
        expected,
        new Uint8Array(expected.length).fill(84)
      ])

      const stmt = db.prepare('select value from blobs order by rowid')
      expect(stmt.step()).toBe(true)
      const value = stmt.getAsObject().value
      expect(value).toEqual(expected)

      expect(stmt.step()).toBe(true)
      expect(value).toEqual(expected)
      stmt.reset()
      expect(value).toEqual(expected)
      stmt.free()
      expect(value).toEqual(expected)
      db.run('select randomblob(1048576)')
      expect(value).toEqual(expected)
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

    test('creates views and preserves them when exporting a database', () => {
      db.run('create table items (value text)')
      db.run("insert into items values ('kept'), ('hidden')")
      db.run(
        "create view kept_items as select value from items where value = 'kept'"
      )
      expect(db.exec('select * from kept_items')[0].values).toEqual([['kept']])

      const restored = new Database(db.export())
      try {
        expect(restored.exec('select * from kept_items')[0].values)
          .toEqual([['kept']])
        restored.run('drop view kept_items')
        expect(restored.exec(
          "select count(*) from sqlite_master where name = 'kept_items'"
        )[0].values).toEqual([[0]])
      } finally {
        restored.close()
      }
    })

    test('supports temporary tables without including them in exports', () => {
      db.run('create temp table temporary_items (value text)')
      db.run("insert into temporary_items values ('temporary')")
      expect(db.exec('select * from temporary_items')[0].values)
        .toEqual([['temporary']])

      const restored = new Database(db.export())
      try {
        expect(restored.exec(
          "select count(*) from sqlite_temp_master where name = 'temporary_items'"
        )[0].values).toEqual([[0]])
      } finally {
        restored.close()
      }
    })

    test('supports attached in-memory databases', () => {
      db.run("attach ':memory:' as extra")
      db.run('create table extra.items (value text)')
      db.run("insert into extra.items values ('attached')")
      expect(db.exec('select * from extra.items')[0].values)
        .toEqual([['attached']])
      db.run('detach extra')
    })

    test('vacuums databases before export', () => {
      db.run('create table payloads (value blob)')
      db.run('insert into payloads values (zeroblob(1048576))')
      db.run('delete from payloads')
      const sizeBeforeVacuum = db.export().byteLength
      db.run('vacuum')
      const sizeAfterVacuum = db.export().byteLength
      expect(sizeAfterVacuum).toBeLessThan(sizeBeforeVacuum)
    })

    test('supports window functions', () => {
      db.run('create table scores (value integer)')
      db.run('insert into scores values (30), (10), (20)')
      expect(db.exec(`
        select
          value,
          row_number() over (order by value),
          sum(value) over (
            order by value
            rows between unbounded preceding and current row
          )
        from scores
        order by value
      `)[0].values).toEqual([
        [10, 1, 10],
        [20, 2, 30],
        [30, 3, 60]
      ])
    })

    test('executes triggers after exporting and reopening a database', () => {
      db.run('create table items (value text)')
      db.run('create table item_log (value text)')
      db.run(`
        create trigger log_item after insert on items begin
          insert into item_log values (new.value);
        end
      `)
      db.run("insert into items values ('before export')")

      const restored = new Database(db.export())
      try {
        restored.run("insert into items values ('after export')")
        expect(
          restored.exec('select value from item_log order by rowid')[0].values
        )
          .toEqual([['before export'], ['after export']])
      } finally {
        restored.close()
      }
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
      ['EXPLAIN', 'explain select 1'],
      ['ALTER TABLE', 'alter table items add column title text'],
      ['ANALYZE', 'analyze items']
    ])('intentionally omits %s', (_feature, sql) => {
      db.run('create table items (value text)')
      expect(() => db.exec(sql)).toThrow()
      expect(db.exec('select 1')[0].values).toEqual([[1]])
    })
  })
}
