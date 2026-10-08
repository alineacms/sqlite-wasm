// A content database like alinea's: entries with JSON data and indexes on
// type and path, parent and entry id. 20,000 rows of about 2.4 KB come to
// about 50 MB with 64 KB pages. The same seed gives the same database.

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam ' +
  'quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo ' +
  'consequat duis aute irure in reprehenderit voluptate velit esse cillum ' +
  'fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt ' +
  'culpa qui officia deserunt mollit anim id est laborum'
).split(' ')

const TYPES = ['Page', 'Article', 'Product', 'Author', 'Category']

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function words(next, count) {
  const out = []
  for (let i = 0; i < count; i++) out.push(WORDS[Math.floor(next() * WORDS.length)])
  return out.join(' ')
}

export const SCHEMA = `
  create table entries (
    id integer primary key,
    entryId text not null,
    type text not null,
    locale text not null,
    path text not null,
    parentId text,
    status text not null,
    data text not null
  );
  create unique index entries_entryId on entries (entryId, locale);
  create index entries_type_path on entries (type, path);
  create index entries_parent on entries (parentId);
`

/** Row `i`, with `version` changing its title and body */
export function entry(i, version = 0) {
  const next = random(i * 7919 + version * 104729 + 1)
  const type = TYPES[i % TYPES.length]
  const title = `${words(next, 5)} ${i}`
  const blocks = []
  for (let b = 0; b < 8; b++) {
    blocks.push({
      id: `block-${i}-${b}`,
      type: b % 3 === 0 ? 'Heading' : 'Paragraph',
      text: words(next, b % 3 === 0 ? 6 : 38)
    })
  }
  const data = JSON.stringify({
    title,
    version,
    summary: words(next, 30),
    tags: [words(next, 1), words(next, 1), words(next, 1)],
    blocks
  })
  return [
    i,
    `entry-${i.toString(36).padStart(5, '0')}`,
    type,
    i % 4 === 0 ? 'nl' : 'en',
    `${type.toLowerCase()}/${title.replaceAll(' ', '-')}`,
    i < 100 ? null : `entry-${(i % 100).toString(36).padStart(5, '0')}`,
    i % 10 === 0 ? 'draft' : 'published',
    data
  ]
}

/** Fill a new database with `rows` entries. */
export function build(db, rows = 20_000) {
  db.run('pragma page_size = 65536')
  db.exec(SCHEMA)
  db.run('begin')
  const insert = db.prepare('insert into entries values (?, ?, ?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < rows; i++) insert.run(entry(i))
  insert.free()
  db.run('commit')
}

/** Give `count` rows, spread over the table, a new version. */
export function change(db, count, version, rows = 20_000) {
  db.run('begin')
  const update = db.prepare('update entries set data = ?, path = ? where id = ?')
  const step = Math.max(1, Math.floor(rows / count))
  for (let k = 0; k < count; k++) {
    const i = (k * step) % rows
    const row = entry(i, version)
    update.run([row[7], row[4], i])
  }
  update.free()
  db.run('commit')
}

export const QUERIES = {
  point: [
    "select data from entries where entryId = 'entry-00ffa' and locale = 'en'"
  ],
  range: [
    "select count(*), sum(length(data)) from entries where type = 'Article' and path between 'article/a' and 'article/e'"
  ],
  full: ['select count(*), sum(length(data)) from entries']
}

/** A range count the index answers alone, without reading the table */
export const INDEX_COUNT =
  "select count(*) from entries where type = 'Article' and path between 'article/a' and 'article/e'"

