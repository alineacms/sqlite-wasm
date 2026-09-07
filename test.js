import assert from 'node:assert/strict'
import {init} from '@alinea/sqlite-wasm'
import initWasm from './dist/init-wasm.js'

const {Database} = await init()
const db = new Database()

assert.equal(db.exec('select sqlite_version()')[0].values[0][0], '3.53.4')
assert.equal(db.exec(`select json_extract('{"value": 42}', '$.value')`)[0].values[0][0], 42)

db.run('create virtual table pages using fts5(title, body)')
db.run('insert into pages values (?, ?)', ['Modern SQLite', 'full text search works'])
assert.deepEqual(db.exec("select title from pages where pages match 'search'")[0].values, [
  ['Modern SQLite']
])

// Keep size-oriented feature omissions intentional and covered by tests.
for (const sql of [
  "select date('now')",
  'select row_number() over ()',
  'create trigger pages_insert after insert on pages begin select 1; end',
  "attach ':memory:' as extra",
  'vacuum',
  'explain select 1',
  'create view page_titles as select title from pages'
]) {
  assert.throws(() => db.exec(sql), undefined, `${sql} should be unavailable`)
}

db.create_function('twice', value => value * 2)
assert.equal(db.exec('select twice(21)')[0].values[0][0], 42)

const exported = db.export()
db.close()
const restored = new Database(exported)
assert.equal(restored.exec('select count(*) from pages')[0].values[0][0], 1)
restored.run('begin').run("insert into pages values ('Rollback', 'temporary')").run('rollback')
assert.equal(restored.exec('select count(*) from pages')[0].values[0][0], 1)
restored.run("insert into pages values ('Unicode ✓', 'serialized again')")
const reexported = restored.export()
restored.close()

const roundTripped = new Database(reexported)
assert.equal(roundTripped.exec('select count(*) from pages')[0].values[0][0], 2)
roundTripped.close()

const separate = await initWasm()
const separateDb = new separate.Database()
assert.equal(separateDb.exec('select 6 * 7')[0].values[0][0], 42)
separateDb.close()

console.log('SQLite 3.53.4, intentional omissions, JSON, FTS5, bindings, functions, transactions, and both loaders: OK')
