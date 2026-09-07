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

    test('registers sqlite-vec on every database', () => {
      expect(db.exec('select vec_version()')[0].values).toEqual([['v0.1.9']])
      expect(db.exec("select vec_distance_l2('[0,0]', '[3,4]')")[0].values)
        .toEqual([[5]])
    })

    test('searches supplied text and image vectors with cosine distance', () => {
      db.run(`create virtual table embeddings using vec0(
        embedding float[3] distance_metric=cosine,
        +kind text
      )`)
      for (const [id, values, kind] of [
        [1, [1, 0, 0], 'text'],
        [2, [0.8, 0.6, 0], 'image'],
        [3, [0, 1, 0], 'image']
      ]) {
        const bytes = new Uint8Array(new Float32Array(values).buffer)
        db.run('insert into embeddings(rowid, embedding, kind) values (?, ?, ?)',
          [id, bytes, kind])
      }
      const rows = db.exec(`
        select rowid, kind, distance from embeddings
        where embedding match ? and k = 2 order by distance
      `, ['[1,0,0]'])[0].values
      expect(rows.map(row => row.slice(0, 2))).toEqual([[1, 'text'], [2, 'image']])
      expect(rows[0][2]).toBeCloseTo(0)
      expect(rows[1][2]).toBeCloseTo(0.2)
    })

    test('persists vector search through export/import and supports updates', () => {
      db.run('create virtual table embeddings using vec0(embedding float[2])')
      db.run("insert into embeddings(rowid, embedding) values (1, '[0,0]'), (2, '[3,4]')")
      const restored = new Database(db.export())
      const search = database => database.exec(`
        select rowid, distance from embeddings
        where embedding match '[0,0]' and k = 2 order by distance
      `)[0].values
      try {
        expect(search(restored)).toEqual([[1, 0], [2, 5]])
        restored.run("update embeddings set embedding = '[0,2]' where rowid = 2")
        restored.run('delete from embeddings where rowid = 1')
        expect(search(restored)).toEqual([[2, 2]])
        expect(search(db)).toEqual([[1, 0], [2, 5]])
      } finally {
        restored.close()
      }
    })

    test('rolls back vector writes and rejects incorrect dimensions', () => {
      db.run('create virtual table embeddings using vec0(embedding float[2])')
      db.run('begin')
      db.run("insert into embeddings(rowid, embedding) values (1, '[0,0]')")
      db.run('rollback')
      expect(db.exec('select count(*) from embeddings')[0].values).toEqual([[0]])
      expect(() => db.run("insert into embeddings(embedding) values ('[1,2,3]')"))
        .toThrow(/dimension/i)
      db.run("insert into embeddings(embedding) values ('[1,2]')")
      expect(db.exec('select count(*) from embeddings')[0].values).toEqual([[1]])
    })

    test('supports binary quantization and Hamming distance', () => {
      expect(db.exec(`select vec_distance_hamming(
        vec_quantize_binary('[1,1,1,1,-1,-1,-1,-1]'),
        vec_quantize_binary('[1,1,1,-1,-1,-1,-1,-1]')
      )`)[0].values).toEqual([[1]])
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
      ['views', 'create view item_values as select value from items'],
      ['ALTER TABLE', 'alter table items add column title text'],
      ['ANALYZE', 'analyze items']
    ])('intentionally omits %s', (_feature, sql) => {
      db.run('create table items (value text)')
      expect(() => db.exec(sql)).toThrow()
      expect(db.exec('select 1')[0].values).toEqual([[1]])
    })
  })
}
