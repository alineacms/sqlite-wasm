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

The build includes SQLite JSON functions, FTS5, views, triggers, window
functions, temporary tables, `VACUUM`, and `ATTACH` for additional in-memory
databases. Databases live in memory;
use `db.export()` and `new Database(bytes)` to persist and restore their file
representation.

Databases are stored copy-on-write, so `db.fork()` creates an independent copy
without duplicating any data. The fork shares every page with its source and
copies a page only when either side writes to it. It starts from the last
committed state and stays valid after the source is closed.

```ts
const draft = db.fork()
draft.run('delete from messages')
console.log(db.exec('select count(*) from messages')) // unchanged
draft.close()
```

This is deliberately a size-oriented SQLite build. Date/time functions,
`EXPLAIN`, `ALTER TABLE`, and `ANALYZE` are omitted. The complete compile-time
option list is kept in the `SQLITE_OMIT_FLAGS` variable in the Makefile.

## Native extension

The same copy-on-write storage ships as a prebuilt SQLite extension for native
drivers such as `node:sqlite` and `bun:sqlite`. It is built for macOS
(universal), Linux (x64 and arm64, glibc and musl) and Windows (x64). Loading
it registers an `overlay` VFS for the whole process. That VFS opens an
existing database file strictly read-only and keeps all changes in memory.

```ts
import {DatabaseSync} from 'node:sqlite'
import {overlayExtension} from '@alinea/sqlite-wasm/native'

new DatabaseSync(':memory:', {allowExtension: true})
  .loadExtension(overlayExtension())

// Private overlay: changes live as long as this connection.
const db = new DatabaseSync('file:content.db?vfs=overlay')
// Named overlays are shared by every connection that opens them...
const a = new DatabaseSync('file:content.db?vfs=overlay&overlay=a')
// ...and can be forked, like db.fork() above.
const b = new DatabaseSync('file:content.db?vfs=overlay&overlay=b&from=a')
```

- The base file is never written, and no journal or WAL files are created
  next to it.
- Each overlay holds a shared lock on the base file, so other writers get
  `SQLITE_BUSY` while overlays are open.
- A WAL-mode base must be checkpointed; a leftover `-wal` file is ignored.
- An overlay is discarded when its last connection closes.
- `PRAGMA overlay_pages` returns the number of pages held in memory.
- `VACUUM INTO 'file:out.db?vfs=unix'` (`vfs=win32` on Windows) saves an
  overlay to disk.
- In `bun:sqlite`, open overlays with
  `new Database(uri, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI)`,
  because Bun's SQLite does not parse `file:` URIs by default. On macOS, also
  call `Database.setCustomSQLite` with a SQLite build that allows extensions,
  such as Homebrew's.

## Development

Open the repository in its VS Code devcontainer, then run:

```sh
bun install --frozen-lockfile
bun run build
bun test
```

`bun run build` also builds the native extension for the current platform
into `dist/native`. `bun run build:native` rebuilds only that, and
`node --test native.test.ts` runs its tests under Node.js. CI builds and
tests the extension on every supported platform, and releases publish all
of the binaries.

The toolchain is pinned in the devcontainer and package manifest. The build
uses SQLite's in-memory pager with a minimal VFS, so it does not ship
Emscripten's JavaScript filesystem implementation. The Makefile downloads and
checksums SQLite's canonical source archive, applies the small compatibility
patch needed by this feature set, and generates the custom amalgamation before
compiling it.

Forked from [kbumsik/sqlite-wasm](https://github.com/kbumsik/sqlite-wasm).
