import type {Commit, Database, Persistence, Storage} from './Database.js'

// Layout: the database file is stored in chunks, keyed by chunk index, next
// to a record with the file size and chunk size. Every write is a single
// IndexedDB transaction covering one or more whole SQLite commits, so the
// stored file is always a committed state.
const VERSION = 1
const CHUNKS = 'chunks'
const META = 'meta'
const META_KEY = 'database'
const READ_BYTES = 4 << 20

interface Meta {
  size: number
  chunkSize: number
}

/** Commits that are not stored yet, merged in order. */
interface Batch {
  /** Chunks from this index on are deleted before `chunks` are written */
  truncate: number
  chunks: Map<number, Uint8Array>
  /** Set once the batch holds a commit */
  meta?: Meta
}

function emptyBatch(): Batch {
  return {truncate: Infinity, chunks: new Map()}
}

/** Apply a later batch on top of an earlier one. */
function merge(into: Batch, batch: Batch): Batch {
  if (batch.truncate < into.truncate) into.truncate = batch.truncate
  if (batch.truncate < Infinity) {
    for (const index of into.chunks.keys())
      if (index >= batch.truncate) into.chunks.delete(index)
  }
  for (const [index, chunk] of batch.chunks) into.chunks.set(index, chunk)
  into.meta = batch.meta ?? into.meta
  return into
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openStore(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CHUNKS)
      req.result.createObjectStore(META)
    }
    req.onsuccess = () => {
      const idb = req.result
      // Let indexedDB.deleteDatabase() proceed; later writes then fail.
      idb.onversionchange = () => idb.close()
      resolve(idb)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Load the stored file into db, and return its size (0 if none). */
async function loadInto(idb: IDBDatabase, db: Database): Promise<number> {
  const tx = idb.transaction([CHUNKS, META], 'readonly')
  const meta = await request<Meta | undefined>(
    tx.objectStore(META).get(META_KEY)
  )
  if (!meta) return 0
  const {size, chunkSize} = meta
  const chunks = tx.objectStore(CHUNKS)
  const perRead = Math.max(1, Math.floor(READ_BYTES / chunkSize))
  // Pass a few MiB at a time to the database, so the file is never in memory
  // twice. Chunks that were never written are missing and read as zero.
  for (let start = 0; start < size; start += perRead * chunkSize) {
    const first = start / chunkSize
    const part = new Uint8Array(Math.min(perRead * chunkSize, size - start))
    const range = IDBKeyRange.bound(first, first + perRead, false, true)
    const [keys, values] = await Promise.all([
      request(chunks.getAllKeys(range)),
      request(chunks.getAll(range))
    ])
    for (let i = 0; i < keys.length; i++) {
      const offset = ((keys[i] as number) - first) * chunkSize
      if (offset >= part.byteLength) break
      part.set(
        (values[i] as Uint8Array).subarray(0, part.byteLength - offset),
        offset
      )
    }
    // Keeping the stored chunk size keeps chunk indexes stable, also after
    // VACUUM changed the page size.
    db.load(part, start, size, chunkSize)
  }
  return size
}

function writeBatch(idb: IDBDatabase, batch: Batch): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction([CHUNKS, META], 'readwrite', {
      durability: 'strict'
    })
    tx.oncomplete = () => resolve()
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    try {
      const chunks = tx.objectStore(CHUNKS)
      if (batch.truncate < Infinity)
        chunks.delete(IDBKeyRange.lowerBound(batch.truncate))
      for (const [index, chunk] of batch.chunks) chunks.put(chunk, index)
      tx.objectStore(META).put(batch.meta, META_KEY)
    } catch (error) {
      // Never commit part of a batch.
      tx.abort()
      reject(error)
    }
  })
}

// Databases that are still writing after close()
const closing = new Map<string, Promise<void>>()

class IndexedDBPersistence implements Persistence {
  private pending = emptyBatch()
  // Resolves when the last scheduled write is done, to its error if it failed
  private queue: Promise<unknown> = Promise.resolve()
  private scheduled = false
  // Resolves when closed, to the error of the final write if it failed
  private closed?: Promise<unknown>

  constructor(
    private name: string,
    private idb: IDBDatabase,
    private size: number
  ) {}

  commit = ({chunkSize, size, minSize, chunks}: Commit) => {
    const truncate =
      minSize < this.size ? Math.ceil(minSize / chunkSize) : Infinity
    merge(this.pending, {truncate, chunks, meta: {size, chunkSize}})
    this.size = size
    this.schedule()
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    this.queue = this.queue.then(() => this.write())
  }

  private async write(): Promise<unknown> {
    this.scheduled = false
    const batch = this.pending
    this.pending = emptyBatch()
    try {
      await writeBatch(this.idb, batch)
      return undefined
    } catch (error) {
      // Retried with the next commit or flush.
      this.pending = merge(batch, this.pending)
      return error
    }
  }

  async flush(): Promise<void> {
    if (!this.closed && this.pending.meta) this.schedule()
    const error = await (this.closed ?? this.queue)
    if (error) throw error
  }

  close() {
    if (this.closed) return
    if (this.pending.meta) this.schedule()
    this.closed = this.queue.then(error => {
      this.idb.close()
      return error
    })
    const done: Promise<void> = this.closed.then(() => {
      if (closing.get(this.name) === done) closing.delete(this.name)
    })
    closing.set(this.name, done)
  }
}

/**
 * Keeps a database in the IndexedDB database called `name`. Pass it to
 * `Database.sync` to load the database and store its commits:
 *
 * ```ts
 * import {init} from '@alinea/sqlite-wasm'
 * import {indexedDBStorage} from '@alinea/sqlite-wasm/indexeddb'
 *
 * const {Database} = await init()
 * const db = await Database.sync(indexedDBStorage('notes'))
 * db.run('create table if not exists notes (text)')
 * await db.flush()
 * ```
 *
 * The whole database is loaded into memory. After every commit, the pages it
 * changed are written to IndexedDB in the background. Each IndexedDB
 * transaction holds one or more whole commits, so the stored database always
 * reflects a committed state; commits that were not written yet are lost if
 * the page closes. `db.close()` still writes the remaining commits, and
 * syncing the same name again waits for them.
 *
 * Sync a database in one place at a time, for example in a SharedWorker:
 * nothing coordinates writes between tabs or workers that use the same
 * name. Forks of the database are not stored.
 */
export function indexedDBStorage(name: string): IndexedDBStorage {
  return new IndexedDBStorage(name)
}

export class IndexedDBStorage implements Storage {
  constructor(public readonly name: string) {}

  async sync<T extends Database>(
    Database: new (data?: ArrayBufferView) => T
  ): Promise<T> {
    let idb: IDBDatabase | undefined
    try {
      await closing.get(this.name)
      idb = await openStore(this.name)
      const db = new Database()
      try {
        const size = await loadInto(idb, db)
        const persistence = new IndexedDBPersistence(this.name, idb, size)
        db.onCommit(persistence.commit)
        db.persistence = persistence
        return db
      } catch (error) {
        db.close()
        throw error
      }
    } catch (error) {
      idb?.close()
      throw error
    }
  }

  /**
   * Delete the stored database, once commits of a closed database are
   * written. Close the database first: an open one can no longer store.
   */
  async delete(): Promise<void> {
    await closing.get(this.name)
    await request(indexedDB.deleteDatabase(this.name))
  }
}
