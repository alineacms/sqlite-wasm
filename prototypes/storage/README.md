# Storage prototypes

Three ways to store a database without keeping all of it in memory, built
on the package's SQLite build and compared in TinyJoin's comparative
benchmark. These are experiments, not part of the package.

`jsvfs.c` is a SQLite VFS that hands every file operation to
`Module.jsvfs` in JavaScript, so SQLite keeps only its page cache (256 KiB)
in Wasm memory and the backend decides where pages live:

1. **OPFS sync access handles** (`opfs.js`, synchronous build). Pages are
   read and written in place with the default rollback journal, as
   `opfs-sahpool` does. Sync access handles exist only in dedicated
   Workers, so a page (or one elected tab) owns that Worker and the others
   send it their queries.
2. **IndexedDB through JSPI** (`idb.js` `createJSPIBackend`, JSPI build).
   The file is stored as 4 KiB blocks (`pages.js`) with a bounded block
   cache. A read of a block that is not cached returns a Promise, and JSPI
   suspends SQLite until IndexedDB answers; reads from the cache do not
   suspend. Each sync waits for its IndexedDB transaction. Runs in any
   Worker, including a SharedWorker, but needs JSPI (Chromium today).
3. **IndexedDB with retry on a miss** (`idb.js` `createRetryBackend` and
   `retry.js`, synchronous build). The same block store, answered
   synchronously: a read of a block that is not cached fails, the driver
   loads the block and runs the call again. SQLite rolls back the whole
   transaction when a read fails, so a transaction is replayed from its
   BEGIN, and a call's whole read set must fit in memory while it is
   retried. Commits are stored in the background; `flush()` waits.

Both IndexedDB backends use `PRAGMA journal_mode=MEMORY`: each sync is one
IndexedDB transaction, which applies entirely or not at all.

None of them coordinate tabs, or support `fork()`: they open a database
directly with the JS VFS instead of through the copy-on-write overlay.

## Running the benchmark

```sh
bun run build                       # generates the amalgamation in cache/
prototypes/storage/build.sh         # dist/sync and dist/jspi
prototypes/storage/bench/install.sh /path/to/tinyjoin
cd /path/to/tinyjoin
npm run bench:compare -- --engines tinyjoin,sqlite,proto-opfs,proto-jspi,proto-retry
```

`install.sh` copies the prototypes into the benchmark as the engines
`proto-opfs`, `proto-jspi` and `proto-retry` (`bench/` holds their
Workers), along with the package itself as `alinea` (`npm install
@alinea/sqlite-wasm` in `benchmarks/compare` first).
`CACHE_BLOCKS` in `bench/workers.js` sets the IndexedDB block cache.
