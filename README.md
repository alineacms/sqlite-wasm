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
`EXPLAIN` and `ALTER TABLE` are omitted. The complete compile-time option
list is kept in the `SQLITE_OMIT_FLAGS` variable in the Makefile.

## Snapshot storage

`@alinea/sqlite-wasm/snapshots` keeps a database as immutable snapshots,
which any number of Workers open at the same time, dedicated or shared, and
of different builds of an app. Each opens a session: a copy-on-write layer
over a snapshot, from which SQLite reads pages as queries need them, while
every change stays in that Worker's memory. Saving writes a new snapshot
with the changes, which other Workers open from then on. Snapshots are kept
as files in OPFS or as Blobs in IndexedDB; both have the same API, so either
can be swapped in (see [BENCHMARKS.md](BENCHMARKS.md) to compare them).

```ts
import {init} from '@alinea/sqlite-wasm'
import {indexedDBSnapshots, opfsSnapshots} from '@alinea/sqlite-wasm/snapshots'

const {Database} = await init()
const storage = indexedDBSnapshots('entries') // or opfsSnapshots
if (storage.supported()) {
  // The head (newest snapshot) of the branch, or an empty database
  const session = await storage.open(Database, {branch: configHash})
  session.db.run('create table if not exists notes (text)')
  session.db.run('insert into notes values (?)', ['stored'])
  const saved = await session.save({key: contentHash, meta: {tree: treeHash}})
  await storage.retain() // keeps the head of each branch
  await session.close()
}
```

Use it for a cache or a copy of data that lives elsewhere, which many
Workers read and change, where losing recent changes costs a reload. For a
database whose commits must all be stored, use [OPFS storage](#opfs-storage)
with one Worker that owns it, or [IndexedDB storage](#indexeddb-storage).

- There is no writable shared data: snapshots are never changed once
  written, so two Workers can never corrupt each other's data. No journal or
  WAL is written; nothing is loaded into memory up front.
- A branch is a line of snapshots; the newest is its head. A session saves
  to one branch: `storage.open(Database, {branch})` opens its head, and
  without `branch`, the head of all snapshots and its branch. `choose`
  picks another snapshot to start from, out of the readable ones, newest
  first, such as the newest of any branch when this one has none (the
  session still saves to `branch`):

  ```ts
  const session = await storage.open(Database, {
    branch: configHash,
    choose: snapshots =>
      snapshots.find(s => s.branch === configHash) ?? snapshots[0]
  })
  if (session.snapshot && session.snapshot.branch !== configHash)
    reindex(session.db) // content of another config
  ```

  A snapshot that turns out unreadable (deleted meanwhile, or lying over a
  missing one) is left out and `choose` asked again. Without a snapshot to
  open, the database starts empty. `{key}` opens a given snapshot, and
  fails with `SQLITE_CANTOPEN` if it cannot be read; a snapshot that is not
  a database fails with `SQLITE_CORRUPT`.
- The session has the database as `session.db`, the snapshot it reads (after
  a save, the one it wrote or joined) as `session.snapshot`, the branch it
  saves to as `session.branch`, and the bytes of changed pages it holds in
  memory as `session.held`. `await storage.list()` lists the snapshots,
  newest first (`{branch}` for one branch), with their `key`, `branch`,
  `meta`, `createdAt` and `size`; `await storage.head(branch)` returns the
  head.
- Changes are kept in memory until a save: commits since the last one are
  lost when the session closes or its Worker ends. `await session.close()`
  closes it, and `close({save: {key}})` saves first.
- `await session.save({key, meta})` writes snapshot `key` (by
  default a key of its own): the snapshot the database reads with the pages
  it holds written over it. Then the database reads the new snapshot and
  drops those pages from memory; changes made meanwhile stay. The database
  keeps working: the save captures the committed state when it is called,
  and saves of a session run one at a time, to its branch. `meta` is any
  data that survives structured cloning.
- A save writes only the pages that changed, as a delta over the snapshot
  the database reads (`parent` in its info), while that snapshot is of the
  same branch (so a branch never needs another's), and keeps at most 8
  deltas on a full snapshot, the new pages are at most half the database,
  and all those deltas together no more than the database; else it writes
  the whole database. In Chromium, saving 10 changed rows of a 47 MB database
  takes 12–27 ms instead of 120–210 ms (see [BENCHMARKS.md](BENCHMARKS.md)). Reads look
  through the deltas to the full snapshot below. `opfsSnapshots(name,
  {maxDepth})` changes how many deltas may lie on one; `0` writes every
  snapshot in full.
- Key snapshots by their content, such as a content hash: a key that exists
  is not written again. The result's `status` tells what happened:
  `'written'`, a new snapshot; `'joined'`, the key holds the committed state
  of the database byte for byte, so it reads that snapshot from then on as
  if it had written it; `'mismatch'`, the key holds other content, and the
  database stays as it is. Bytes only match when the same commits were made
  on the same snapshot: reaching the same content another way stores it
  differently (the header counts commits, and free pages keep old bytes).
  The newest save wins: new Workers open it, and Workers on older snapshots
  keep reading those, with their own changes.
- `session.fork()` is a new session on a fork of the database, with the same
  snapshot, changes and branch, which saves on its own. `db.fork()` works
  as usual too.
- `storage.session(db, {branch})` makes a session for a database the
  storage did not open, such as one loaded from bytes: its first save
  writes all of it.
- `await storage.retain()` deletes every snapshot that is not the head of
  its branch, or one a kept snapshot lies over, and resolves to their
  keys. `retain({perBranch: n})` keeps the newest `n` of each branch, `retain({branches: n})` deletes every snapshot
  of all but the `n` branches with the newest heads (with OPFS and no Web
  Locks, also ones Workers still read), and `retain({pinned: keys})` never
  deletes those keys.
- SQLite keeps up to 8 MB of the pages it read in its page cache
  (`PRAGMA cache_size` changes it).
- `save` fails during a write transaction (`SQLITE_BUSY`), and `session`
  for a database stored elsewhere (`SQLITE_MISUSE`).

### Automatic saves

Sessions save when you call `save`, or, if you ask for it, by themselves:

```ts
const session = await storage.open(Database, {
  branch: configHash,
  autoSave: {
    maxHeld: 32 << 20, // once 32 MB of changed pages are held
    after: 5000, // 5 seconds after the last commit
    key: db => contentKey(db), // or undefined to skip this save
    meta: db => ({tree: treeOf(db)})
  }
})
```

- `maxHeld` saves as soon as the database holds that many bytes of changed
  pages: a large import or reindex no longer holds the whole database in
  memory. `after` saves once commits stop for that many milliseconds; each
  commit restarts the wait. Neither is on by default.
- A save never starts inside a transaction (the commit that ends it
  counts), and one runs at a time.
- `key` names each snapshot. Key snapshots by content where you can, so
  Workers that reach the same content share one snapshot; return
  `undefined` while the database is between consistent states, such as
  halfway through a sync of several transactions. Without `key`, every save
  gets a key of its own.
- `storage.session(db, {autoSave})` does the same for a database you
  already have. Automatic saves stop when the session or its database
  closes. Errors go to `onError` (default: `reportError`).
- Saves are not free (see [BENCHMARKS.md](BENCHMARKS.md), notably IndexedDB
  in WebKit), so keep `after` at seconds rather than milliseconds.

### Snapshots in IndexedDB

`indexedDBSnapshots(name)` keeps each snapshot as a record of IndexedDB
database `name`, with its key, branch, meta, time and size, and its content
as a Blob: for a delta, its pages and their layout. A full save reads the
old snapshot into memory and adds the changed pages, so it briefly holds
the whole database in memory (WebKit stores a Blob composed of slices of
other IndexedDB Blobs wrongly once it is over about 32 MB); either is
added in one transaction. Workers read Blobs synchronously with
`FileReaderSync`. A
Blob stays readable after its record is deleted, so `retain` needs no
locks: it deletes old snapshots even while Workers read them. Pass
`{indexedDB, IDBKeyRange}` to use another implementation, such as
fake-indexeddb.

### Snapshots in OPFS

`opfsSnapshots(name)` keeps each snapshot as a file in directory `name` of
OPFS (or of `{directory}`), with its branch and meta (and for a delta, the
layout of its pages) in a file next to it. A save writes the new file with
`createWritable()`: a delta's pages, or for a full save the old snapshot
streamed in with the changed pages written over it. Closing the writer
shows the file at once. A file stops being readable once it is deleted, so Workers hold a
shared Web Lock on each snapshot they read (also through forks), and on
those it lies over, and `retain` keeps the snapshots a Worker reads. Saves to one key lock it, so
one Worker writes it. Without Web Locks (`{locks: null}`) `retain` keeps
one more snapshot per branch, and snapshots still being written until they
are an hour old; every browser with `createWritable()` has Web Locks. `new
SnapshotStorage(directorySnapshotStore(name, directory))` keeps files in
any other `SnapshotDirectory`.

### Snapshots in memory

`memorySnapshots(store)` keeps snapshots as bytes in a
`memorySnapshotStore()`, for tests and for Node and Bun, which have neither
OPFS nor `FileReaderSync`. Storages given the same store share its
snapshots, as Workers share OPFS or IndexedDB.

Snapshots in IndexedDB and in OPFS are tested in Chromium, Firefox and
WebKit, in dedicated and shared Workers; `storage.supported()` tells if the
APIs they need are there.
`readOnlyFile(blobOrBytes)` reads a `File`, `Blob` or `Uint8Array` as a
read-only `SyncFile`, and `new SnapshotStorage(store)` takes any other
`SnapshotStore`.

## Opening a database file without loading it

`openOverlay(Database, file)` opens a database over a file that does not
change while it is open, as snapshot storage does: SQLite reads pages as
queries need them, every change stays in memory, and `db.fork()` is cheap.
In Node and Bun, `readOnlyFileAt(path)` from `@alinea/sqlite-wasm/file`
reads a file of the file system with `fs.readSync`, where the native
`overlay` extension cannot be loaded:

```ts
import {init} from '@alinea/sqlite-wasm'
import {readOnlyFileAt} from '@alinea/sqlite-wasm/file'
import {openOverlay} from '@alinea/sqlite-wasm/snapshots'

const {Database} = await init()
const db = openOverlay(Database, readOnlyFileAt('generated.db'))
```

- Nothing locks the file, so it must not be written in place while it is
  open: each read checks that its size and modification time are as they
  were, and fails with `SQLITE_IOERR_READ` if not. Replace it instead (write
  a new file and rename it over the path): open databases keep reading the
  file they opened.
- The file closes once the database and its forks are closed.
- `file` can also be a `File`, `Blob` or `Uint8Array`, or any read-only
  `SyncFile`. Opening a file that is not a database fails with
  `SQLITE_CORRUPT`.
- SQLite keeps up to 8 MB of the pages it read in its page cache (`PRAGMA
  cache_size` changes it).

## Storing every commit

Snapshot storage keeps changes in memory until a save. When every
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

CI also publishes the package of every commit to main and every pull
request to [pkg.pr.new](https://pkg.pr.new), with all native binaries and
version `0.0.0-preview-<sha>`, so a fix can be used before it is released:

```sh
bun add https://pkg.pr.new/@alinea/sqlite-wasm@<sha>
```

Pull requests get a comment with the URL of their latest commit.

The toolchain is pinned in the devcontainer and package manifest. The build
stores databases in the copy-on-write overlay VFS (`src/overlay.c`), and
files only through a small VFS answered by JavaScript (`src/jsvfs.c`), so it
does not ship Emscripten's JavaScript filesystem implementation. The Makefile downloads and
checksums SQLite's canonical source archive, applies the small compatibility
patch needed by this feature set, and generates the custom amalgamation before
compiling it.

Forked from [kbumsik/sqlite-wasm](https://github.com/kbumsik/sqlite-wasm).
