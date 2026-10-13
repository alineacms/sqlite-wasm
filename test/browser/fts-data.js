// The full-text search database of the browser benchmarks: 30,000 entries
// with a path index and an FTS5 table of about 200 MB, as alinea's
// dashboard keeps its content, and the searches it runs on it.

export const ROWS = 30_000

export function random(seed) {
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

function texts(seed) {
  const next = random(seed)
  const words = vocabulary(random(42))
  const word = () => words[Math.floor(words.length * next() ** 2)]
  return {next, text: count => Array.from({length: count}, word).join(' ')}
}

/** Fill `db`, empty, with the entries and their search index */
export function fill(db) {
  const {text} = texts(42)
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
}

/**
 * Change entries all over in `rounds` transactions of `count`, as syncs
 * do: rewritten text, and the index with it
 */
export function scatter(db, rounds, count = 100) {
  const {next, text} = texts(7)
  for (let round = 0; round < rounds; round++) {
    db.run('begin')
    for (let i = 0; i < count; i++) {
      const id = 1 + Math.floor(next() * ROWS)
      const title = text(6)
      db.run('update entries set title = ? where id = ?', [title, id])
      db.run('delete from search where rowid = ?', [id])
      db.run('insert into search (rowid, title, body) values (?, ?, ?)', [
        id,
        title,
        text(300 + Math.floor(next() * 300))
      ])
    }
    db.run('commit')
  }
}

/** The searches, as [name, run] */
export function queries(db) {
  const all = (sql, params) => db.exec(sql, params)[0]?.values ?? []
  const out = []
  // Prefix searches as one types, ranked, with snippets of the top ones
  for (const prefix of ['k', 'ke', 'kel', 'm', 'mo', 'mor'])
    out.push([
      `match ${prefix}*`,
      () =>
        all(
          `select rowid, snippet(search, 1, '[', ']', '…', 8) from search
           where search match ? order by rank limit 50`,
          [`${prefix}*`]
        ).length
    ])
  // A broad search that reads the entry of every match
  out.push([
    'match a* join entries',
    () =>
      all(
        `select count(*), sum(length(e.title)) from search
         join entries e on e.id = search.rowid where search match 'a*'`
      )[0][0]
  ])
  // Lookups by path through an index, in random order
  out.push([
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
  return out
}
