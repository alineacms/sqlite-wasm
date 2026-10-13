// The Worker of fts-bench.js: builds a database with an FTS5 table of
// about 130 MB and saves it as a snapshot in IndexedDB, or opens that
// snapshot and times full-text searches and indexed lookups on it, as
// alinea's dashboard searches its cache. Counts the Blob reads
// (FileReaderSync) each query makes.
import {init} from '@alinea/sqlite-wasm'
import {indexedDBSnapshots} from '@alinea/sqlite-wasm/snapshots'

const ready = init()
const STORAGE = 'fts-bench'

let blobReads = 0
const read = FileReaderSync.prototype.readAsArrayBuffer
FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
  blobReads++
  return read.call(this, blob)
}

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// 20,000 made-up words of 4 to 10 letters, used with a skewed frequency
function vocabulary(next) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const words = new Set()
  while (words.size < 20_000) {
    let word = ''
    const length = 4 + Math.floor(next() * 7)
    for (let i = 0; i < length; i++) word += letters[Math.floor(next() * 26)]
    words.add(word)
  }
  return [...words]
}

const ROWS = 30_000

const actions = {
  async build() {
    const {Database} = await ready
    const next = random(42)
    const words = vocabulary(next)
    const word = () => words[Math.floor(words.length * next() ** 2)]
    const text = count => Array.from({length: count}, word).join(' ')
    const storage = indexedDBSnapshots(STORAGE)
    const session = await storage.open(Database)
    const db = session.db
    db.run(`
      create table entries (id integer primary key, path text not null, title text not null);
      create index entries_path on entries (path);
      create virtual table search using fts5 (title, body);
    `)
    db.run('begin')
    const entry = db.prepare('insert into entries (id, path, title) values (?, ?, ?)')
    const search = db.prepare('insert into search (rowid, title, body) values (?, ?, ?)')
    for (let id = 1; id <= ROWS; id++) {
      const title = text(6)
      entry.run([id, `/entries/${id}`, title])
      search.run([id, title, text(450)])
    }
    entry.free()
    search.free()
    db.run('commit')
    const start = performance.now()
    await session.save({key: 'base'})
    const saveMs = performance.now() - start
    const [[pages, pageSize]] = db.exec(
      'select page_count, page_size from pragma_page_count, pragma_page_size'
    )[0].values
    db.close()
    return {rows: ROWS, bytes: pages * pageSize, pageSize, saveMs}
  },

  async query({readCache} = {}) {
    const {Database} = await ready
    const storage = indexedDBSnapshots(STORAGE, {readCache})
    let start = performance.now()
    blobReads = 0
    const session = await storage.open(Database, {key: 'base'})
    const db = session.db
    const results = {open: {ms: performance.now() - start, blobReads}}
    const time = (name, run) => {
      blobReads = 0
      const start = performance.now()
      const rows = run()
      results[name] = {ms: performance.now() - start, blobReads, rows}
    }
    const all = (sql, params) => db.exec(sql, params)[0]?.values ?? []
    const queries = []
    // Prefix searches as one types, ranked, with snippets of the top ones
    for (const prefix of ['k', 'ke', 'kel', 'm', 'mo', 'mor'])
      queries.push([
        `match ${prefix}*`,
        () =>
          all(
            `select rowid, snippet(search, 1, '[', ']', '…', 8) from search
             where search match ? order by rank limit 50`,
            [`${prefix}*`]
          ).length
      ])
    // A broad search that reads the entry of every match
    queries.push([
      'match a* join entries',
      () =>
        all(
          `select count(*), sum(length(e.title)) from search
           join entries e on e.id = search.rowid where search match 'a*'`
        )[0][0]
    ])
    // Lookups by path through an index, in random order
    queries.push([
      '2000 indexed lookups',
      () => {
        const next = random(7)
        let found = 0
        const lookup = db.prepare('select id, title from entries where path = ?')
        for (let i = 0; i < 2000; i++) {
          lookup.bind([`/entries/${1 + Math.floor(next() * ROWS)}`])
          if (lookup.step()) found++
          lookup.reset()
        }
        lookup.free()
        return found
      }
    ])
    // Twice: the second round reads again what left SQLite's page cache
    for (const round of [1, 2]) {
      let total = 0
      let reads = 0
      for (const [name, run] of queries) {
        time(`${name} (${round})`, run)
        total += results[`${name} (${round})`].ms
        reads += results[`${name} (${round})`].blobReads
      }
      results[`round ${round}`] = {ms: total, blobReads: reads}
    }
    db.close()
    return results
  }
}

self.onmessage = async ({data: {id, action, args}}) => {
  try {
    self.postMessage({id, result: await actions[action](args)})
  } catch (error) {
    self.postMessage({id, error: String(error?.stack ?? error)})
  }
}
