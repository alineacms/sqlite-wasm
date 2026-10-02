// Prototypes 2 and 3: the database file in IndexedDB (see pages.js), with
// only a bounded cache of its blocks in memory. Run the database with
// `PRAGMA journal_mode=MEMORY`: every sync is one IndexedDB transaction,
// which IndexedDB applies entirely or not at all.
//
// createJSPIBackend (prototype 2) awaits IndexedDB inside the VFS calls,
// for the JSPI build: a read waits for missing blocks, and a sync waits
// until its transaction completes.
//
// createRetryBackend (prototype 3) answers synchronously, for the
// synchronous build. A read of a block that is not in memory fails with
// SQLITE_IOERR_READ and records the block in `missing`; the driver loads
// them (see retry.js) and runs the statement, or transaction, again. A sync
// starts the IndexedDB transaction in the background, as the in-memory
// IndexedDB storage does; await flush() for it.

import {PageStore} from './pages.js'

const SQLITE_IOERR_READ = 266
const SQLITE_IOERR_WRITE = 778

function files(name) {
  // Only the database file is stored; the journal is kept in memory by
  // SQLite and temporary files are in memory (SQLITE_TEMP_STORE=3).
  return {open: (file) => (file === name ? 0 : -1), close: () => 0, delete: () => 0, exists: () => 0}
}

export async function createJSPIBackend(module, name, options) {
  const store = await PageStore.open(name, options)
  module.jsvfs = {
    ...files(name),
    // Answers synchronously from memory; returns a Promise (and suspends
    // SQLite) only when blocks must be fetched. The heap may grow while
    // waiting, so views are taken afresh.
    read(id, ptr, size, offset) {
      const view = () => module.HEAPU8.subarray(ptr, ptr + size)
      const missing = store.read(view(), offset)
      if (!missing) return 0
      return store.fetch(missing).then(() => (store.read(view(), offset) ? SQLITE_IOERR_READ : 0))
    },
    write(id, ptr, size, offset) {
      const view = () => module.HEAPU8.subarray(ptr, ptr + size)
      const missing = store.write(view(), offset)
      if (!missing) return 0
      return store.fetch(missing).then(() => (store.write(view(), offset) ? SQLITE_IOERR_WRITE : 0))
    },
    truncate(id, size) {
      store.truncate(size)
      return 0
    },
    async sync() {
      await store.commit()
      return store.error ? SQLITE_IOERR_WRITE : 0
    },
    size: () => store.size,
  }
  return store
}

export async function createRetryBackend(module, name, options) {
  const store = await PageStore.open(name, options)
  const missing = new Set()
  module.jsvfs = {
    ...files(name),
    read(id, ptr, size, offset) {
      const blocks = store.read(module.HEAPU8.subarray(ptr, ptr + size), offset)
      if (!blocks) return 0
      for (const index of blocks) missing.add(index)
      return SQLITE_IOERR_READ
    },
    write(id, ptr, size, offset) {
      const blocks = store.write(module.HEAPU8.subarray(ptr, ptr + size), offset)
      if (!blocks) return 0
      for (const index of blocks) missing.add(index)
      return SQLITE_IOERR_WRITE
    },
    truncate(id, size) {
      store.truncate(size)
      return 0
    },
    sync() {
      store.commit()
      return 0
    },
    size: () => store.size,
  }
  store.missing = missing
  return store
}
