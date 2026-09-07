# @alinea/sqlite-wasm

SQLite compiled to WebAssembly for browsers, workers, edge runtimes, Node.js,
and Bun. The package exposes a small `sql.js`-compatible database API and ships
both a deflate-compressed Base64 build and a separate Wasm build.

```ts
import {init} from '@alinea/sqlite-wasm'

const {Database} = await init()
const db = new Database()
db.run('create table messages (text)')
db.run('insert into messages values (?)', ['hello'])
console.log(db.exec('select * from messages'))
db.close()
```

The build includes SQLite JSON functions, FTS5, and
[sqlite-vec 0.1.9](https://github.com/asg017/sqlite-vec) under its MIT license.
Databases live in memory;
use `db.export()` and `new Database(bytes)` to persist and restore their file
representation.

This is deliberately a size-oriented SQLite build. Date/time functions, window
functions, triggers, `ATTACH`, `VACUUM`, `EXPLAIN`, views, `ALTER TABLE`, and
`ANALYZE` are omitted. The
complete compile-time option list is kept in the `SQLITE_OMIT_FLAGS` variable in
the Makefile.

## Vector search in the browser

Supply embeddings from your own model. You can generate text and image vectors
ahead of time, insert them into a database, and ship the exported database to
the browser. No embedding model or external service is bundled.

```js
const {Database} = await init()
const db = new Database()
db.run(`create virtual table embeddings using vec0(
  embedding float[3] distance_metric=cosine,
  +kind text
)`)

// Illustrative vectors; replace with your model's output and dimension.
const vector = new Float32Array([1, 0, 0])
db.run('insert into embeddings(rowid, embedding, kind) values (?, ?, ?)', [
  1,
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
  'image'
])

// Save these bytes during content preparation.
const bytes = db.export()
db.close()

// In the browser, bytes can instead come from fetch('/search.sqlite').
const searchDb = new Database(bytes)
const queryVector = new Float32Array([0.9, 0.1, 0])
const results = searchDb.exec(`
  select rowid, kind, distance from embeddings
  where embedding match ? and k = 10
  order by distance
`, [new Uint8Array(queryVector.buffer)])
console.log(results)
searchDb.close()
```

Query embeddings must use the same model and vector space as the stored
embeddings. Text-to-image search needs a model with a shared text/image space.
Loading the database restores vector storage directly; no JavaScript search
index needs rebuilding. FTS5 remains available for keyword search, and callers
can combine its results with vector results for hybrid search.

The extension registers automatically on every database connection. Its
filesystem helpers are excluded for browsers; `AUTOINCREMENT` is enabled
because `vec0` uses it internally. The distributed package includes the
sqlite-vec MIT license notice.

## Development

Open the repository in its VS Code devcontainer, then run:

```sh
bun install --frozen-lockfile
bun run build
bun test
```

The toolchain is pinned in the devcontainer and package manifest. The build
uses SQLite's in-memory pager with a minimal VFS, so it does not ship
Emscripten's JavaScript filesystem implementation. The Makefile downloads and
checksums SQLite's canonical source archive, applies the small compatibility
patch needed by this feature set, and generates the custom amalgamation before
compiling it.

Forked from [kbumsik/sqlite-wasm](https://github.com/kbumsik/sqlite-wasm).
