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
representation, or [sync them with IndexedDB](#indexeddb-storage).

Databases are stored copy-on-write, so `db.fork()` creates an independent copy
without duplicating any data. The fork shares every page with its source and
copies a page only when either side writes to it. It starts from the last
committed state, cannot be created during a write transaction, and stays valid
after the source is closed.

```ts
const draft = db.fork()
draft.run('delete from messages')
console.log(db.exec('select count(*) from messages')) // unchanged
draft.close()
```

This is deliberately a size-oriented SQLite build. Date/time functions,
`EXPLAIN`, `ALTER TABLE`, and `ANALYZE` are omitted. The complete compile-time
option list is kept in the `SQLITE_OMIT_FLAGS` variable in the Makefile.

## IndexedDB storage

In browsers and workers, `Database.sync` loads a database from IndexedDB,
or starts an empty one, and keeps storing its commits there:

```ts
import {init} from '@alinea/sqlite-wasm'
import {indexedDBStorage} from '@alinea/sqlite-wasm/indexeddb'

const {Database} = await init()
const storage = indexedDBStorage('notes')
const db = await Database.sync(storage)
db.run('create table if not exists notes (text)')
db.run('insert into notes values (?)', ['stored'])
await db.flush()
```

- The whole database is loaded into memory, and queries run synchronously as
  usual. After every commit, the pages it changed are written to IndexedDB
  in the background.
- Each IndexedDB transaction holds one or more whole commits, so the stored
  database is always a committed state. Commits that were not written yet
  are lost if the page closes or crashes.
- `await db.flush()` resolves once every commit so far is stored and rejects
  if writing failed (for example, over quota); failed writes are retried with
  the next commit or flush. `db.flush()` resolves right away for in-memory
  databases.
- `db.close()` still writes the remaining commits, and storing a database
  under the same name again waits for them. After closing,
  `await storage.delete()` removes the stored database.
- One database at a time is stored under a name: syncing, attaching or
  deleting a name that is in use fails with `SQLITE_BUSY`. Store a database
  in one place at a time, for example in a SharedWorker; nothing coordinates
  writes between tabs or workers that use the same name.
- `db.fork()` creates an in-memory copy, which is not stored unless you
  attach it, and `db.export()` returns the file as usual.

### Attaching and detaching

`await db.attach(storage)` stores a database that is in memory already, such
as a fork, without loading anything. Its committed state when storing starts
replaces whatever the storage held, and every later commit is stored, as
with `Database.sync`. `db.detach()` stops storing a database and keeps it in
memory. Together they hand a database over to new storage without waiting
for the old one:

```ts
const next = db.fork()
await next.attach(indexedDBStorage('notes-v2'))
db.detach()
await next.flush() // the replacement is stored
```

- The replacement is written in a single IndexedDB transaction that deletes
  the stored pages, then writes every page and the file size. IndexedDB
  applies a transaction entirely or not at all, so until it completes the
  storage keeps its previous database, and a crash or a closed page never
  leaves a mix of both. If it fails, it is retried with the next commit or
  flush.
- The whole database is copied out of the Wasm heap for that transaction.
- `attach` fails during a write transaction, and for a database that is
  stored already; detach it first.
- After `db.detach()`, the commits made so far are still written, and
  `db.flush()` waits for them and rejects if that failed. Later commits are
  not stored or kept for storing, and `db.close()` writes nothing. Storing a
  database under the same name again waits for the final write, as after
  `close()`.

### Errors

Errors from SQLite, and from storing a database, are `SQLiteError`s
(exported by `@alinea/sqlite-wasm`) with the name of the result code in
`error.code`, such as `'SQLITE_CONSTRAINT'` or `'SQLITE_BUSY'`, and its
number in `error.resultCode`. Check `code` rather than the class, which
differs between two copies of this package. Errors from IndexedDB itself,
such as a `QuotaExceededError`, are passed on as they are.

`Database.sync` rejects with `code` `'SQLITE_CORRUPT'` if the stored data is
not a valid database: an invalid size record, header or page size, fewer
pages than the header lists, or a schema that cannot be read. Delete it to
start over:

```ts
const storage = indexedDBStorage('notes')
const db = await Database.sync(storage).catch(async error => {
  if (error.code !== 'SQLITE_CORRUPT') throw error
  await storage.delete()
  return Database.sync(storage)
})
```

These checks cover the header and the schema, not every page: damage
elsewhere surfaces when a query reads it. `PRAGMA integrity_check` is left
out of this build.

### Other IndexedDB implementations

`indexedDBStorage(name, {indexedDB, IDBKeyRange})` uses the given
implementation instead of the globals, for example fake-indexeddb in tests:

```ts
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb'

const storage = indexedDBStorage('notes', {indexedDB: new IDBFactory(), IDBKeyRange})
```

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
- `from=` fails with `SQLITE_BUSY` while the source overlay is committing, or
  while it is held with `locking_mode=exclusive`.
- Set `PRAGMA mmap_size` (for example `268435456`) on every connection,
  including each fork, to read the pages an overlay has not changed straight
  from the memory-mapped base file. Where the file is not in the OS page cache
  yet, this turns many small reads into a few large ones.
- `PRAGMA overlay_pages` returns the number of pages an overlay holds alone,
  not shared with the overlay it was forked from or with its forks.
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
