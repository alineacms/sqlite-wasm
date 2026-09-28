import type {Commit, Database, Persistence, Storage} from './Database.js'
import {SQLiteError} from './SQLiteError.js'

// Layout: the database file is stored in chunks, keyed by chunk index, next
// to a record with the file size and chunk size. Every write is a single
// IndexedDB transaction covering one or more whole SQLite commits, so the
// stored file is always a committed state.
const VERSION = 1
const CHUNKS = 'chunks'
const META = 'meta'
const META_KEY = 'database'
const READ_BYTES = 4 << 20
const SQLITE_BUSY = 5
const SQLITE_CORRUPT = 11

interface Meta {
  size: number
  chunkSize: number
}

/**
 * An IndexedDB implementation to use instead of the global one, such as
 * fake-indexeddb in tests: `indexedDBStorage(name, await
 * import('fake-indexeddb'))`.
 */
export interface IndexedDBOptions {
  indexedDB: IDBFactory
  IDBKeyRange: typeof IDBKeyRange
}

interface IndexedDB {
  factory: IDBFactory
  KeyRange: typeof IDBKeyRange
}

function indexedDBApi(options?: IndexedDBOptions): IndexedDB {
  const factory = options ? options.indexedDB : globalThis.indexedDB
  const KeyRange = options ? options.IDBKeyRange : globalThis.IDBKeyRange
  if (!factory || !KeyRange) throw new Error('IndexedDB is not available')
  return {factory, KeyRange}
}

/**
 * Thrown by `Database.sync` when the stored database is not a valid SQLite
 * database, with `code` `'SQLITE_CORRUPT'`. Delete it with
 * `storage.delete()` to start over.
 */
export class CorruptDatabaseError extends SQLiteError {
  constructor(message: string, options?: {cause?: unknown}) {
    super(`Stored database is corrupt: ${message}`, SQLITE_CORRUPT, options)
    this.name = 'CorruptDatabaseError'
  }
}

function isPowerOfTwo(n: number, min: number, max: number) {
  return Number.isInteger(n) && n >= min && n <= max && (n & (n - 1)) === 0
}

function checkMeta(meta: unknown): asserts meta is Meta {
  const {size, chunkSize} = (meta ?? {}) as Partial<Meta>
  if (!isPowerOfTwo(chunkSize!, 512, 65536))
    throw new CorruptDatabaseError(`invalid chunk size ${chunkSize}`)
  if (!Number.isSafeInteger(size) || size! < 0)
    throw new CorruptDatabaseError(`invalid size ${size}`)
}

const MAGIC = 'SQLite format 3\0'

/**
 * Check the header of a database file of `size` bytes. SQLite checks more
 * when it reads the schema (see checkSchema), but not that pages are
 * missing from the end.
 */
function checkHeader(header: Uint8Array, size: number) {
  if (size < 512) throw new CorruptDatabaseError(`too small (${size} bytes)`)
  for (let i = 0; i < MAGIC.length; i++)
    if (header[i] !== MAGIC.charCodeAt(i))
      throw new CorruptDatabaseError('not an SQLite database')
  const view = new DataView(header.buffer, header.byteOffset, 100)
  const field = view.getUint16(16)
  const pageSize = field === 1 ? 65536 : field
  if (!isPowerOfTwo(pageSize, 512, 65536))
    throw new CorruptDatabaseError(`invalid page size ${field}`)
  // The page count in the header is valid if it was written by the same
  // change as the change counter.
  const pageCount = view.getUint32(28)
  const stored = Math.ceil(size / pageSize)
  if (view.getUint32(92) === view.getUint32(24) && pageCount > stored)
    throw new CorruptDatabaseError(
      `${pageCount} pages in the header, ${stored} stored`
    )
}

/** Read the schema, which fails if the loaded file is not a database. */
function checkSchema(db: Database) {
  try {
    db.exec('select count(*) from sqlite_schema')
  } catch (error) {
    throw new CorruptDatabaseError(
      error instanceof Error ? error.message : String(error),
      {cause: error}
    )
  }
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

function openStore(api: IndexedDB, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = api.factory.open(name, VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CHUNKS)
      req.result.createObjectStore(META)
    }
    req.onsuccess = () => {
      const idb = req.result
      // Let deleteDatabase() from elsewhere proceed; later writes then fail.
      idb.onversionchange = () => idb.close()
      resolve(idb)
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Load the stored file into db, and return its size, or undefined if nothing
 * is stored. Reads run in one transaction, so they see one committed state.
 * The transaction stays active across the awaits: each continuation runs in
 * the microtask checkpoint of the success event that resolved it.
 */
async function loadInto(
  api: IndexedDB,
  idb: IDBDatabase,
  db: Database
): Promise<number | undefined> {
  const tx = idb.transaction([CHUNKS, META], 'readonly')
  const meta = await request<unknown>(tx.objectStore(META).get(META_KEY))
  if (meta === undefined) return undefined
  checkMeta(meta)
  const {size, chunkSize} = meta
  const chunks = tx.objectStore(CHUNKS)
  const perRead = Math.max(1, Math.floor(READ_BYTES / chunkSize))
  // Pass a few MiB at a time to the database, so the file is never in memory
  // twice. Chunks that were never written are missing and read as zero.
  for (let start = 0; start < size; start += perRead * chunkSize) {
    const first = start / chunkSize
    const part = new Uint8Array(Math.min(perRead * chunkSize, size - start))
    const range = api.KeyRange.bound(first, first + perRead, false, true)
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
    if (start === 0) checkHeader(part, size)
    // Keeping the stored chunk size keeps chunk indexes stable, also after
    // VACUUM changed the page size.
    db.load(part, start, size, chunkSize)
  }
  return size
}

function writeBatch(
  api: IndexedDB,
  idb: IDBDatabase,
  batch: Batch
): Promise<void> {
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
        chunks.delete(api.KeyRange.lowerBound(batch.truncate))
      for (const [index, chunk] of batch.chunks) chunks.put(chunk, index)
      tx.objectStore(META).put(batch.meta, META_KEY)
    } catch (error) {
      // Never commit part of a batch.
      tx.abort()
      reject(error)
    }
  })
}

/** The names in use in one IndexedDB implementation, in this realm. */
interface Names {
  /** Names a database is stored in, or about to be */
  active: Set<string>
  /** Names still writing after close() or detach() */
  closing: Map<string, Promise<void>>
}

const registry = new WeakMap<IDBFactory, Names>()

function namesIn(api: IndexedDB): Names {
  let names = registry.get(api.factory)
  if (!names) registry.set(api.factory, (names = {active: new Set(), closing: new Map()}))
  return names
}

function busy(name: string) {
  return new SQLiteError(
    `IndexedDB database "${name}" stores another database; close or detach it first`,
    SQLITE_BUSY
  )
}

class IndexedDBPersistence implements Persistence {
  private pending = emptyBatch()
  // Resolves when the last scheduled write is done, to its error if it failed
  private queue: Promise<unknown> = Promise.resolve()
  private scheduled = false
  // Resolves when closed, to the error of the final write if it failed
  private closed?: Promise<unknown>

  /** size: of the stored file, or Infinity to replace it on first write */
  constructor(
    private api: IndexedDB,
    private names: Names,
    private name: string,
    private idb: IDBDatabase,
    private size: number
  ) {}

  commit = ({chunkSize, size, minSize, chunks}: Commit) => {
    // Closed: nothing is stored anymore, so nothing is kept either.
    if (this.closed) return
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
      await writeBatch(this.api, this.idb, batch)
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
    const {active, closing} = this.names
    const done: Promise<void> = this.closed.then(() => {
      if (closing.get(this.name) === done) closing.delete(this.name)
    })
    closing.set(this.name, done)
    active.delete(this.name)
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
 * or to `db.attach` to store a database that is in memory already, which
 * replaces what the storage held.
 *
 * The whole database is kept in memory. After every commit, the pages it
 * changed are written to IndexedDB in the background. Each IndexedDB
 * transaction holds one or more whole commits, so the stored database always
 * reflects a committed state; commits that were not written yet are lost if
 * the page closes. `db.close()` and `db.detach()` still write the remaining
 * commits, and storing a database under the same name again waits for them.
 *
 * One database at a time is stored under a name: syncing or attaching a
 * name that is in use fails with `SQLITE_BUSY`. Store a database in one place
 * at a time, for example in a SharedWorker: nothing coordinates writes
 * between tabs or workers that use the same name.
 */
export function indexedDBStorage(
  name: string,
  options?: IndexedDBOptions
): IndexedDBStorage {
  return new IndexedDBStorage(name, options)
}

export class IndexedDBStorage implements Storage {
  constructor(
    public readonly name: string,
    private readonly options?: IndexedDBOptions
  ) {}

  sync<T extends Database>(
    Database: new (data?: ArrayBufferView) => T
  ): Promise<T> {
    return this.store(() => new Database(), true)
  }

  async attach(db: Database): Promise<void> {
    await this.store(() => db, false)
  }

  /**
   * Store the database create() returns from now on, after loading the
   * stored one into it, or else replacing it.
   */
  private async store<T extends Database>(
    create: () => T,
    load: boolean
  ): Promise<T> {
    const api = indexedDBApi(this.options)
    const names = namesIn(api)
    // Taken right away, so two calls cannot both store under the name.
    if (names.active.has(this.name)) throw busy(this.name)
    names.active.add(this.name)
    let idb: IDBDatabase | undefined
    let db: T | undefined
    let persistence: IndexedDBPersistence | undefined
    const previous = load ? undefined : create().persistence
    try {
      await names.closing.get(this.name)
      idb = await openStore(api, this.name)
      db = create()
      // Infinity: the first write replaces whatever is stored.
      let size = Infinity
      if (load) {
        size = (await loadInto(api, idb, db)) ?? Infinity
        if (size > 0 && size < Infinity) checkSchema(db)
      }
      persistence = new IndexedDBPersistence(api, names, this.name, idb, size)
      db.onCommit(persistence.commit)
      db.persistence = persistence
      // Its committed state right now replaces what is stored.
      if (!load) db.persistAll()
      return db
    } catch (error) {
      if (load) {
        db?.close()
      } else if (db) {
        db.detach()
        db.persistence = previous
      }
      if (persistence) {
        persistence.close()
      } else {
        names.active.delete(this.name)
        idb?.close()
      }
      throw error
    }
  }

  /**
   * Delete the stored database, once the commits of a closed or detached
   * database are written. Fails with `SQLITE_BUSY` while a database is
   * stored under this name.
   */
  async delete(): Promise<void> {
    const api = indexedDBApi(this.options)
    const names = namesIn(api)
    if (names.active.has(this.name)) throw busy(this.name)
    await names.closing.get(this.name)
    await request(api.factory.deleteDatabase(this.name))
  }
}
