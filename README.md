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
databases. Databases live in memory. In browsers,
[snapshot storage](#snapshot-storage) lets any number of Workers open the
same stored database at once without loading it into memory; where every
commit must be stored and one Worker owns the database,
[sync it with IndexedDB](#indexeddb-storage) or
[store it in OPFS](#opfs-storage). `db.export()` and `new Database(bytes)`
save and restore the file itself.

Databases are stored copy-on-write, so `db.fork()` creates an independent copy
without duplicating any data. The fork shares every page with its source and
copies a page only when either side writes to it. It starts from the last
committed state, cannot be created during a write transaction, and stays valid
after the source is closed. It has the page cache size (`PRAGMA cache_size`)
of its source.

```ts
const draft = db.fork()
draft.run('delete from messages')
console.log(db.exec('select count(*) from messages')) // unchanged
draft.close()
```

This is deliberately a size-oriented SQLite build. Date/time functions,
`EXPLAIN`, `ALTER TABLE`, and `ANALYZE` are omitted. The complete compile-time
option list is kept in the `SQLITE_OMIT_FLAGS` variable in the Makefile.

## Snapshot storage

`@alinea/sqlite-wasm/snapshots` keeps a database in immutable bases, which
any number of Workers open at the same time, dedicated or shared, and of
different builds of an app. Each opens a copy-on-write overlay on a base:
SQLite reads pages from it as queries need them, and every change stays in
that Worker's memory. A checkpoint writes a new base with the changes,
which other Workers open from then on. Bases are kept as files in OPFS or
as Blobs in IndexedDB; both have the same API, so either can be swapped in
(see [BENCHMARKS.md](BENCHMARKS.md) to compare them).

```ts
import {init} from '@alinea/sqlite-wasm'
import {
  indexedDBSnapshotStorage,
  opfsSnapshotStorage
} from '@alinea/sqlite-wasm/snapshots'

const {Database} = await init()
const storage = indexedDBSnapshotStorage('entries') // or opfsSnapshotStorage
if (storage.supported()) {
  // The newest base of the group, or an empty database
  const db = await storage.open(Database, {group: configHash})
  db.run('create table if not exists notes (text)')
  db.run('insert into notes values (?)', ['stored'])
  await storage.checkpoint(db, contentHash, {
    group: configHash,
    meta: {tree: treeHash}
  })
  await storage.cleanup() // keeps the newest base of each group
}
```

Use it for a cache or a copy of data that lives elsewhere, which many
Workers read and change, where losing recent changes costs a reload. For a
database whose commits must all be stored, use [OPFS storage](#opfs-storage)
with one Worker that owns it, or [IndexedDB storage](#indexeddb-storage).

- There is no writable shared data: bases are never changed once written,
  so two Workers can never corrupt each other's data. No journal or WAL is
  written; nothing is loaded into memory up front.
- `storage.open(Database)` opens the newest base, `storage.open(Database,
  {group})` the newest of a group, and `storage.open(Database, key)` a
  given one. With `{group, fallback: 'any'}`, a group without bases opens
  the newest base of any group. Without a base to open, the database
  starts empty. Opening a missing base fails with `SQLITE_CANTOPEN`, a
  base that is not a database with `SQLITE_CORRUPT`. `await
  storage.list()` lists the bases, newest first, with their `key`,
  `group`, `meta`, `createdAt` and `size`, and `baseOf(db)` returns the
  one a database reads (after a checkpoint, the one it wrote), or
  `undefined`.
- Changes are kept in memory until a checkpoint: commits since the last
  one are lost when the database closes or its Worker ends.
  `PRAGMA overlay_pages` tells how many pages a database holds in memory.
- `await storage.checkpoint(db, key, {group, meta})` writes base `key`: the
  base the database reads with the pages it holds written over it. Then
  the database reads the new base and drops those pages from memory;
  changes made meanwhile stay. The database keeps working: the checkpoint
  captures the committed state when it is called. The group defaults to
  the one the database was opened for or last checkpointed to, else the
  group of the base it reads; `meta` is any data that survives structured
  cloning.
- Key bases by their content, such as a content hash: a checkpoint to a key
  that exists writes nothing, leaves the database as it is, and resolves
  to `false`. The newest checkpoint wins: new Workers open it, and Workers
  on older bases keep reading those, with their own changes.
- `db.fork()` works as usual; a fork keeps reading the base it was forked
  on. `storage.checkpoint(fork, key)` writes a fork too.
- `await storage.cleanup()` deletes every base that is not the newest of
  its group, and resolves to their keys. `cleanup({keepGroups: n})` also
  deletes the bases of all but the `n` groups with the newest bases (with
  OPFS and no Web Locks, also ones Workers still read).
- SQLite keeps up to 8 MB of the pages it read in its page cache
  (`PRAGMA cache_size` changes it).
- `checkpoint` fails during a write transaction (`SQLITE_BUSY`), and for a
  database stored elsewhere (`SQLITE_MISUSE`).

### Automatic checkpoints

Checkpoints are written when you call `checkpoint`, or, if you ask for it,
by the database itself:

```ts
const db = await storage.open(Database, {
  group: configHash,
  checkpoint: {
    maxHeld: 32 << 20, // once 32 MB of changed pages are held
    after: 5000, // 5 seconds after the last commit
    key: db => contentKey(db), // or undefined to skip this checkpoint
    meta: db => ({tree: treeOf(db)})
  }
})
```

- `maxHeld` checkpoints as soon as the database holds that many bytes of
  changed pages: a large import or reindex no longer holds the whole
  database in memory. `after` checkpoints once commits stop for that many
  milliseconds; each commit restarts the wait. Neither is on by default.
- A checkpoint never starts inside a transaction (the commit that ends it
  counts), and one runs at a time.
- `key` names each base. Key bases by content where you can, so Workers
  that reach the same content share one base; return `undefined` while the
  database is between consistent states, such as halfway through a sync of
  several transactions. Without `key`, every checkpoint gets a key of its
  own.
- `storage.autoCheckpoint(db, options)` does the same for a database you
  already have, and returns a function that stops it; it also stops when
  the database closes. Errors go to `onError` (default: `reportError`).
- Checkpoints are not free (see [BENCHMARKS.md](BENCHMARKS.md), notably
  IndexedDB in WebKit), so keep `after` at seconds rather than
  milliseconds.

### Bases in IndexedDB

`indexedDBSnapshotStorage(name)` keeps each base as a record of IndexedDB
database `name`, with its key, group, meta, time and size, and its content
as a Blob. A checkpoint composes a new Blob from slices of the old one and
the changed pages, so the browser copies the old base itself, and adds it
in one transaction. Workers read Blobs synchronously with `FileReaderSync`.
A Blob stays readable after its record is deleted, so cleanup needs no
locks: it deletes old bases even while Workers read them. Pass
`{indexedDB, IDBKeyRange}` to use another implementation, such as
fake-indexeddb.

### Bases in OPFS

`opfsSnapshotStorage(name)` keeps each base as a file in directory `name`
of OPFS (or of `{directory}`), with its group and meta in a file next to
it. A checkpoint streams the old base into a `createWritable()` of the new
file, writes the changed pages over it, and closes it, which shows the file
at once. A file stops being readable once it is deleted, so Workers hold a
shared Web Lock on each base they read (also through forks), and cleanup
keeps the bases a Worker reads. Checkpoints to one key lock it, so one
Worker writes it. Without Web Locks (`{locks: null}`) cleanup keeps the
newest two bases of each group, and bases still being written until they
are an hour old; every browser with `createWritable()` has Web Locks. `new
SnapshotStorage(directoryBaseStore(name, directory))` keeps files in any
other `SnapshotDirectory`.

### Bases in memory

`memorySnapshotStorage(store)` keeps bases as bytes in a
`memoryBaseStore()`, for tests and for Node and Bun, which have neither
OPFS nor `FileReaderSync`. Storages given the same store share its bases,
as Workers share OPFS or IndexedDB.

Bases in IndexedDB and in OPFS are tested in Chromium, Firefox and
WebKit, in dedicated and shared Workers; `storage.supported()` tells if the
APIs they need are there.
`readOnlyFile(blobOrBytes)` reads a `File`, `Blob` or `Uint8Array` as a
read-only `SyncFile`, and `new SnapshotStorage(store)` takes any other
`BaseStore`.

## Storing every commit

Snapshot storage keeps changes in memory until a checkpoint. When every
commit must be stored when it returns, and one Worker can own the database,
use IndexedDB storage, which keeps the database in memory and writes each
commit to IndexedDB, or OPFS storage, which keeps it in a file and reads
pages as needed.

### IndexedDB storage

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

#### Attaching and detaching

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

#### Errors

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

#### Other IndexedDB implementations

`indexedDBStorage(name, {indexedDB, IDBKeyRange})` uses the given
implementation instead of the globals, for example fake-indexeddb in tests:

```ts
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb'

const storage = indexedDBStorage('notes', {indexedDB: new IDBFactory(), IDBKeyRange})
```

### OPFS storage

In a dedicated Worker, `Database.sync` can also keep a database in a file of
the origin private file system (OPFS). Unlike IndexedDB storage, the database
is not loaded into memory: pages are read from the file as queries need them.

```ts
import {init} from '@alinea/sqlite-wasm'
import {opfsStorage} from '@alinea/sqlite-wasm/opfs'

const {Database} = await init()
const db = await Database.sync(opfsStorage('notes.sqlite3'))
db.run('create table if not exists notes (text)')
db.run('insert into notes values (?)', ['stored'])
```

- Only SQLite's page cache and the pages of the open transaction are held
  in memory, so a database can be larger than the memory available to it.
- Every commit is stored when it returns: it is appended to a journal next
  to the file (`notes.sqlite3-journal`) and synced there, and written to
  the file itself. The file is synced, and the journal started over, every
  few megabytes and when the database closes. Opening the database replays
  the journal after a crash, so it always holds the last commit. `await
  db.flush()` stores commits that failed to write, and rejects if that
  fails again.
- OPFS files can only be opened this way in a dedicated Worker, by one
  Worker at a time: syncing a database that another Worker or tab holds
  fails with `SQLITE_BUSY`. Have one Worker own the database and the other
  tabs send it their queries, or use [snapshot storage](#snapshot-storage).
  No cross-origin isolation headers are needed.
- `db.fork()` creates an in-memory snapshot, as for any database. It keeps
  its content when the stored database changes or closes, copying the pages
  it still read from the file first.
- `await db.attach(opfsStorage(name))` stores a database that is in memory:
  its committed state replaces what the file held, written as one commit,
  and from then on it is no longer kept in memory. `db.detach()` stores the
  last commits, reads every page into memory and closes the file; `await
  db.flush()` rejects if storing those commits failed. Neither works during
  a write transaction (`SQLITE_BUSY`).
- `await storage.delete()` removes the file and its journal once the
  database is closed or detached.

`opfsStorage(name, {directory})` keeps the files in a directory of OPFS
instead of its root. `fileStorage(name, fileSystem)` uses any other
`FileSystem` that opens files for synchronous access.

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

`bun run test:browser` runs the tests in `test/browser` in headless
Chromium, which OPFS and snapshot storage need; install the browser
it expects once with `bunx playwright-core install chromium`. Add
`--browser firefox` or `--browser webkit` to run them in another browser.
`bun script/test-browser.ts --bench` runs the snapshot storage benchmarks
and writes their results to `bench-results/`, and
`bun script/benchmark-report.ts` turns those into the tables of
[BENCHMARKS.md](BENCHMARKS.md).

`bun run build` also builds the native extension for the current platform
into `dist/native`. `bun run build:native` rebuilds only that, and
`node --test native.test.ts` runs its tests under Node.js. CI builds and
tests the extension on every supported platform, and releases publish all
of the binaries.

The toolchain is pinned in the devcontainer and package manifest. The build
stores databases in the copy-on-write overlay VFS (`src/overlay.c`), and
files only through a small VFS answered by JavaScript (`src/jsvfs.c`), so it
does not ship Emscripten's JavaScript filesystem implementation. The Makefile downloads and
checksums SQLite's canonical source archive, applies the small compatibility
patch needed by this feature set, and generates the custom amalgamation before
compiling it.

Forked from [kbumsik/sqlite-wasm](https://github.com/kbumsik/sqlite-wasm).
