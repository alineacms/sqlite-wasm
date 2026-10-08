import type {Database} from './Database.js'
import {filesOf, type SyncFile} from './opfs.js'
import {SQLiteError} from './SQLiteError.js'

// Databases on immutable bases: every Worker opens a copy-on-write overlay
// over a base, which SQLite reads pages from as it needs them (through the
// "js" VFS, jsvfs.c), and keeps every change in memory. Bases are never
// written once they exist, so any number of Workers, also of different
// builds, can read them at the same time. A checkpoint writes a new base:
// the current one with the pages the database holds written over it, after
// which the database reads that one instead and drops those pages (see
// "Read-only base files of another VFS" in overlay.c).
//
// Where bases are kept is up to a SnapshotStore: files in OPFS
// (opfsSnapshotStorage) or Blobs in IndexedDB (indexedDBSnapshotStorage).
//
// Locks (Web Locks API), per base, for stores that need them (OPFS):
//   read   shared while a database or fork reads it, or a checkpoint writes
//          it; cleanup only deletes bases it can lock exclusively
//   write  exclusive while a checkpoint writes it, so one Worker writes a
//          key and the others find it written

const SQLITE_BUSY = 5
const SQLITE_READONLY = 8
const SQLITE_IOERR_READ = 266
const SQLITE_CORRUPT = 11
const SQLITE_CANTOPEN = 14
const SQLITE_MISUSE = 21
// Pages written to a new base file at once
const WRITE_BYTES = 4 << 20
// Page cache of databases on a base, in KiB (PRAGMA cache_size): pages are
// read from the base again once they leave it, which takes about a
// millisecond for 64 KB.
const CACHE_KIB = 8192
// Without locks, how old an empty base is before cleanup deletes it: one
// that is still being written after this long has failed.
const STALE_MS = 60 * 60_000

/** Content that does not change: a `File` or `Blob`, or bytes. */
export type BaseSource = Blob | Uint8Array

/**
 * A read-only `SyncFile` over `source`. Blobs, such as the `File` of an
 * OPFS file or a Blob read from IndexedDB, are read synchronously with
 * `FileReaderSync`, which Workers have (not the main thread).
 */
export function readOnlyFile(source: BaseSource): SyncFile {
  const readOnly = () => {
    throw new SQLiteError('Bases are read-only', SQLITE_READONLY)
  }
  let read: (buffer: Uint8Array, at: number) => number
  if (source instanceof Uint8Array) {
    read = (buffer, at) => {
      const data = source.subarray(at, at + buffer.length)
      buffer.set(data)
      return data.length
    }
  } else {
    const reader = new FileReaderSync()
    read = (buffer, at) => {
      const end = Math.min(at + buffer.length, source.size)
      if (end <= at) return 0
      const data = reader.readAsArrayBuffer(source.slice(at, end))
      buffer.set(new Uint8Array(data))
      return data.byteLength
    }
  }
  return {
    read: (buffer, {at}) => read(buffer, at),
    getSize: () => sizeOf(source),
    write: readOnly,
    truncate: readOnly,
    flush() {},
    close() {}
  }
}

function sizeOf(source: BaseSource) {
  return source instanceof Uint8Array ? source.byteLength : source.size
}

function slice(source: BaseSource, start: number, end: number): BaseSource {
  return source instanceof Uint8Array
    ? source.subarray(start, end)
    : source.slice(start, end)
}

/** Information stored with a base, which must survive structured cloning */
export type SnapshotMeta = Record<string, unknown>

/** A stored base. */
export interface SnapshotInfo {
  key: string
  /** Bases of one branch replace each other; cleanup keeps the newest */
  branch: string
  meta: SnapshotMeta
  /** When it was written, in milliseconds since 1970 */
  createdAt: number
  /** In bytes; 0 while it is written, or if writing it failed */
  size: number
}

/** A base to write: pages over (part of) an existing base. */
export interface NewSnapshot {
  key: string
  branch: string
  meta: SnapshotMeta
  /** The base the pages go over, of which the first `visible` bytes stay */
  base?: BaseSource
  visible: number
  /** The size of the new base; past `visible`, what no page covers is zero */
  size: number
  chunkSize: number
  /** Indexes of the pages, ascending */
  pages: Array<number>
  /**
   * The content of `pages[i]`: a view of Wasm memory, valid until the next
   * await.
   */
  page(i: number): Uint8Array
}

/** Where a `SnapshotStorage` keeps its bases. */
export interface SnapshotStore {
  /** Names the storage in lock names */
  readonly name: string
  /**
   * If databases hold locks on the bases they read, so cleanup does not
   * delete them, and checkpoints lock the key they write, so one writes it
   */
  readonly locking: boolean
  /** If a base stays readable after it was removed */
  readonly keepsRemoved: boolean
  /** If it works in this context */
  supported(): boolean
  /** Every base, in any order */
  list(): Promise<Array<SnapshotInfo>>
  /** The newest base of `branch` (of all bases without), if it has one */
  head?(branch?: string): Promise<SnapshotInfo | undefined>
  /** Base `key` and its content, which stays as it is, if it exists */
  get(key: string): Promise<{info: SnapshotInfo; source: BaseSource} | undefined>
  /**
   * Write `base`, unless its key exists, and return its content, or
   * undefined if the key exists. A new base appears in full at once.
   */
  write(base: NewSnapshot): Promise<BaseSource | undefined>
  /** Delete base `key`, if it exists. */
  remove(key: string): Promise<void>
}

// ------------------------------------------------------------------------
// OPFS
// ------------------------------------------------------------------------

/** A file in a `SnapshotDirectory`. */
export interface DirectoryFile {
  name: string
  size: number
  lastModified: number
}

/** Writes a new file, which appears in full when it closes. */
export interface FileWriter {
  /** Write `source` from the start of the file. */
  copy(source: BaseSource): Promise<void>
  write(data: Uint8Array, position: number): Promise<void>
  /** Shorten the file, or lengthen it with zeros. */
  truncate(size: number): Promise<void>
  /** Make the file appear, with everything written, at once. */
  close(): Promise<void>
  /** Leave the file as it was. */
  abort(): Promise<void>
}

/** A directory of files, such as one of OPFS. */
export interface SnapshotDirectory {
  /** If it works in this context */
  supported(): boolean
  list(): Promise<Array<DirectoryFile>>
  /** The content of file `name`, which stays as it is, if it exists. */
  get(name: string): Promise<BaseSource | undefined>
  /** Start writing file `name`; it is empty until the writer closes. */
  create(name: string): Promise<FileWriter>
  /** Delete file `name`, if it exists. */
  remove(name: string): Promise<void>
}

function isNotFound(error: unknown) {
  return (error as DOMException)?.name === 'NotFoundError'
}

/**
 * The directory called `name` of the origin private file system, or of
 * `parent`. Files are read with `FileReaderSync` and written with
 * `createWritable()`, which both work in dedicated and shared Workers.
 */
export function opfsSnapshotDirectory(
  name: string,
  parent?: FileSystemDirectoryHandle
): SnapshotDirectory {
  let opened: Promise<FileSystemDirectoryHandle> | undefined
  const directory = () =>
    (opened ??= (parent ? Promise.resolve(parent) : navigator.storage.getDirectory())
      .then(root => root.getDirectoryHandle(name, {create: true}))
      .catch(error => {
        opened = undefined
        throw error
      }))
  return {
    supported() {
      return (
        typeof FileReaderSync === 'function' &&
        typeof navigator !== 'undefined' &&
        typeof navigator.storage?.getDirectory === 'function' &&
        typeof FileSystemFileHandle === 'function' &&
        'createWritable' in FileSystemFileHandle.prototype
      )
    },
    async list() {
      const files: Array<DirectoryFile> = []
      const entries = (await directory()) as unknown as AsyncIterable<
        [string, FileSystemHandle]
      >
      for await (const [name, handle] of entries) {
        if (handle.kind !== 'file') continue
        try {
          const file = await (handle as FileSystemFileHandle).getFile()
          files.push({name, size: file.size, lastModified: file.lastModified})
        } catch (error) {
          // Deleted meanwhile
          if (!isNotFound(error)) throw error
        }
      }
      return files
    },
    async get(name) {
      try {
        return await (await (await directory()).getFileHandle(name)).getFile()
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },
    async create(name) {
      const dir = await directory()
      const handle = await dir.getFileHandle(name, {create: true})
      // Writes go to a copy, which replaces the file when it closes.
      const writable = await handle.createWritable()
      return {
        async copy(source) {
          if (source instanceof Uint8Array) {
            await writable.write({
              type: 'write',
              position: 0,
              data: source as Uint8Array<ArrayBuffer>
            })
          } else {
            await source.stream().pipeTo(writable, {preventClose: true})
          }
        },
        write: (data, position) =>
          writable.write({
            type: 'write',
            position,
            data: data as Uint8Array<ArrayBuffer>
          }),
        truncate: size => writable.truncate(size),
        close: () => writable.close(),
        async abort() {
          await writable.abort()
          // Creating the handle left an empty file behind.
          await dir.removeEntry(name).catch(() => {})
        }
      }
    },
    async remove(name) {
      try {
        await (await directory()).removeEntry(name)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
  }
}

// Base `key` is the file named by encodeKey(key), which never contains a
// dot, and its branch and meta are JSON in that name plus `.json`.
const META_SUFFIX = '.json'

function encodeKey(key: string) {
  return encodeURIComponent(key).replaceAll('.', '%2E')
}

function decodeKey(name: string) {
  return decodeURIComponent(name)
}

async function readText(source: BaseSource) {
  return source instanceof Uint8Array
    ? new TextDecoder().decode(source)
    : source.text()
}

/**
 * Bases as files in `directory`: base `key` in a file named after it, and
 * its branch, meta and time in one next to it (file times can be too coarse
 * to tell which of two bases is newer). Files are written with one writer
 * each, which shows them at once when it closes; the base is created first,
 * empty, and the metadata written before it. Reading a file that is
 * deleted is not guaranteed to work, so this store uses locks.
 */
export function directorySnapshotStore(
  name: string,
  directory: SnapshotDirectory
): SnapshotStore {
  // The metadata of base `key`, with its time, or else `lastModified`
  async function readMeta(key: string, lastModified: number) {
    const source = await directory.get(encodeKey(key) + META_SUFFIX)
    let stored: {branch?: unknown; meta?: SnapshotMeta; createdAt?: unknown} = {}
    try {
      if (source) stored = JSON.parse(await readText(source)) ?? {}
    } catch {}
    return {
      branch: String(stored.branch ?? ''),
      meta: stored.meta ?? {},
      createdAt:
        typeof stored.createdAt === 'number' ? stored.createdAt : lastModified
    }
  }
  async function writeFile(file: string, data: Uint8Array) {
    const writer = await directory.create(file)
    try {
      await writer.copy(data)
      await writer.close()
    } catch (error) {
      await writer.abort().catch(() => {})
      throw error
    }
  }
  return {
    name,
    locking: true,
    keepsRemoved: false,
    supported: () => directory.supported(),
    async list() {
      const files = await directory.list()
      return Promise.all(
        files
          .filter(file => !file.name.endsWith(META_SUFFIX))
          .map(async file => {
            const key = decodeKey(file.name)
            return {
              key,
              ...(await readMeta(key, file.lastModified)),
              size: file.size
            }
          })
      )
    },
    async get(key) {
      const source = await directory.get(encodeKey(key))
      if (!source) return undefined
      const lastModified =
        source instanceof Blob && 'lastModified' in source
          ? (source as File).lastModified
          : 0
      return {
        info: {key, ...(await readMeta(key, lastModified)), size: sizeOf(source)},
        source
      }
    },
    async write(base) {
      const file = encodeKey(base.key)
      const existing = await directory.get(file)
      if (existing && sizeOf(existing) > 0) return undefined
      // The empty base file appears first, so the metadata is never left
      // without one.
      const writer = await directory.create(file)
      try {
        const meta = JSON.stringify({
          branch: base.branch,
          meta: base.meta,
          createdAt: now()
        })
        await writeFile(file + META_SUFFIX, new TextEncoder().encode(meta))
        if (base.base && base.visible > 0) {
          if (sizeOf(base.base) < base.visible)
            throw new SQLiteError('Base is too short', SQLITE_IOERR_READ)
          await writer.copy(slice(base.base, 0, base.visible))
        }
        await writer.truncate(base.visible)
        // Write runs of consecutive pages at once.
        const {chunkSize, pages} = base
        const perWrite = Math.max(1, Math.floor(WRITE_BYTES / chunkSize))
        for (let i = 0; i < pages.length; ) {
          let end = i + 1
          while (
            end < pages.length &&
            end - i < perWrite &&
            pages[end] === pages[end - 1] + 1
          )
            end++
          const run = new Uint8Array((end - i) * chunkSize)
          for (let k = i; k < end; k++)
            run.set(base.page(k), (k - i) * chunkSize)
          await writer.write(run, pages[i] * chunkSize)
          i = end
        }
        await writer.truncate(base.size)
        await writer.close()
      } catch (error) {
        await writer.abort().catch(() => {})
        await directory.remove(file + META_SUFFIX).catch(() => {})
        throw error
      }
      return directory.get(file)
    },
    async remove(key) {
      await directory.remove(encodeKey(key))
      await directory.remove(encodeKey(key) + META_SUFFIX)
    }
  }
}

// ------------------------------------------------------------------------
// IndexedDB
// ------------------------------------------------------------------------

// Version 1 stored groups; its bases are dropped (they are a cache).
const IDB_VERSION = 2
const BASES = 'bases'
const BY_BRANCH = 'branch'
const BY_TIME = 'createdAt'

/** A base as IndexedDB stores it. */
interface BaseRecord extends SnapshotInfo {
  blob: Blob
}

/**
 * An IndexedDB implementation to use instead of the global one, such as
 * fake-indexeddb in tests.
 */
export interface IndexedDBImplementation {
  indexedDB: IDBFactory
  IDBKeyRange: typeof IDBKeyRange
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

/** Milliseconds since 1970, finer than Date.now() where available */
// performance.now() can stop while the system sleeps, so a long-lived
// Worker's clock would fall behind: never go below the wall clock.
function now() {
  return typeof performance !== 'undefined' && performance.timeOrigin
    ? Math.max(Date.now(), performance.timeOrigin + performance.now())
    : Date.now()
}

/**
 * The content of `base` as one Blob: slices of the old base and copies of
 * the pages, composed by the browser without copying the old base.
 */
function composeBlob(base: NewSnapshot): Blob {
  const parts: Array<BlobPart> = []
  let at = 0
  // The old base up to `end`, and zeros past what is visible of it.
  const fill = (end: number) => {
    const keep = Math.min(end, base.visible)
    if (base.base && keep > at)
      parts.push(slice(base.base, at, keep) as BlobPart)
    const from = Math.max(at, keep)
    if (end > from) parts.push(new Uint8Array(end - from))
    at = end
  }
  base.pages.forEach((index, i) => {
    const start = index * base.chunkSize
    if (start >= base.size) return
    fill(start)
    const page = base.page(i)
    // The Blob copies the bytes out of Wasm memory.
    const length = Math.min(page.byteLength, base.size - start)
    parts.push(page.subarray(0, length) as Uint8Array<ArrayBuffer>)
    at = start + length
  })
  fill(base.size)
  return new Blob(parts)
}

/**
 * Bases as Blobs in IndexedDB database `name`: one record per base with its
 * key, branch, meta, time and size, indexed by branch and time. Writing one
 * composes a Blob of slices of the old base and the changed pages, and adds
 * it in one transaction. A Blob that was read stays readable after its
 * record is deleted, so this store needs no locks.
 */
export function indexedDBSnapshotStore(
  name: string,
  implementation?: IndexedDBImplementation
): SnapshotStore {
  let opened: Promise<IDBDatabase> | undefined
  const api = () => {
    const factory = implementation?.indexedDB ?? globalThis.indexedDB
    const KeyRange = implementation?.IDBKeyRange ?? globalThis.IDBKeyRange
    if (!factory || !KeyRange) throw new Error('IndexedDB is not available')
    return {factory, KeyRange}
  }
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = api().factory.open(name, IDB_VERSION)
      req.onupgradeneeded = () => {
        const idb = req.result
        if (idb.objectStoreNames.contains(BASES)) idb.deleteObjectStore(BASES)
        const store = idb.createObjectStore(BASES, {keyPath: 'key'})
        store.createIndex(BY_BRANCH, ['branch', 'createdAt'])
        store.createIndex(BY_TIME, 'createdAt')
      }
      req.onsuccess = () => {
        const idb = req.result
        // Let deleteDatabase() from elsewhere proceed; open again after.
        idb.onversionchange = () => {
          idb.close()
          opened = undefined
        }
        resolve(idb)
      }
      req.onerror = () => reject(req.error)
    }).catch(error => {
      opened = undefined
      throw error
    }))
  const store = async (mode: IDBTransactionMode) =>
    (await database()).transaction(BASES, mode).objectStore(BASES)
  const info = ({key, branch, meta, createdAt, size}: BaseRecord): SnapshotInfo => ({
    key,
    branch,
    meta,
    createdAt,
    size
  })
  return {
    name,
    locking: false,
    keepsRemoved: true,
    supported() {
      return (
        typeof FileReaderSync === 'function' &&
        (implementation !== undefined || typeof globalThis.indexedDB === 'object')
      )
    },
    async list() {
      const records = await request<Array<BaseRecord>>(
        (await store('readonly')).getAll()
      )
      return records.map(info)
    },
    async head(branch) {
      const bases = await store('readonly')
      const {KeyRange} = api()
      const cursor = await request(
        branch === undefined
          ? bases.index(BY_TIME).openCursor(null, 'prev')
          : bases
              .index(BY_BRANCH)
              .openCursor(
                KeyRange.bound([branch, -Infinity], [branch, Infinity]),
                'prev'
              )
      )
      return cursor ? info(cursor.value as BaseRecord) : undefined
    },
    async get(key) {
      const record = await request<BaseRecord | undefined>(
        (await store('readonly')).get(key)
      )
      return record && {info: info(record), source: record.blob}
    },
    async write(base) {
      if (await request((await store('readonly')).count(base.key))) return
      const blob = composeBlob(base)
      const record: BaseRecord = {
        key: base.key,
        branch: base.branch,
        meta: base.meta,
        createdAt: now(),
        size: base.size,
        blob
      }
      const bases = await store('readwrite')
      try {
        // add() fails if another Worker added the key meanwhile.
        await Promise.all([request(bases.add(record)), completion(bases.transaction)])
      } catch (error) {
        if ((error as DOMException)?.name === 'ConstraintError') return
        throw error
      }
      // Read what was stored, which IndexedDB keeps on disk; the composed
      // Blob holds the same, if the record was deleted already.
      const stored = await request<BaseRecord | undefined>(
        (await store('readonly')).get(base.key)
      )
      return stored?.blob ?? blob
    },
    async remove(key) {
      const bases = await store('readwrite')
      await Promise.all([request(bases.delete(key)), completion(bases.transaction)])
    }
  }
}

// ------------------------------------------------------------------------
// Memory
// ------------------------------------------------------------------------

/**
 * Bases as bytes in memory, for tests and runtimes without OPFS or
 * `FileReaderSync` (Node, Bun). Storages that share the store share its
 * bases, as Workers share OPFS or IndexedDB; nothing outlives the store.
 */
export function memorySnapshotStore(name = 'memory'): SnapshotStore {
  // Records are copied in and out, as IndexedDB clones them.
  const copy = (info: SnapshotInfo): SnapshotInfo => ({
    ...info,
    meta: structuredClone(info.meta)
  })
  const bases = new Map<string, {info: SnapshotInfo; data: Uint8Array}>()
  let last = 0
  return {
    name,
    locking: false,
    keepsRemoved: true,
    supported: () => true,
    async list() {
      return [...bases.values()].map(base => copy(base.info))
    },
    async get(key) {
      const base = bases.get(key)
      // The bytes are shared: bases are never written.
      return base && {info: copy(base.info), source: base.data}
    },
    async write(base) {
      if (bases.has(base.key)) return undefined
      const data = new Uint8Array(base.size)
      const keep = Math.min(base.visible, base.size)
      if (base.base && keep > 0) {
        const part = slice(base.base, 0, keep)
        data.set(
          part instanceof Uint8Array
            ? part
            : new Uint8Array(await part.arrayBuffer())
        )
      }
      // Bytes past `visible` that no page covers stay zero.
      base.pages.forEach((index, i) => {
        const start = index * base.chunkSize
        if (start >= base.size) return
        data.set(base.page(i).subarray(0, base.size - start), start)
      })
      if (bases.has(base.key)) return undefined
      // Times that differ, also within a millisecond
      const createdAt = (last = Math.max(now(), last + 0.001))
      const {key, branch, meta, size} = base
      bases.set(key, {
        info: copy({key, branch, meta, createdAt, size}),
        data
      })
      return data
    },
    async remove(key) {
      bases.delete(key)
    }
  }
}


// ------------------------------------------------------------------------
// Storage
// ------------------------------------------------------------------------

export interface SnapshotStorageOptions {
  /**
   * Web Locks implementation, `null` for none (default: `navigator.locks`
   * for stores that use locks, none otherwise)
   */
  locks?: Pick<LockManager, 'request'> | null
}

/**
 * Keeps snapshots as files in the directory called `name` of the origin
 * private file system (OPFS), or of `options.directory`. See
 * `SnapshotStorage`.
 */
export function opfsSnapshots(
  name: string,
  options?: SnapshotStorageOptions & {directory?: FileSystemDirectoryHandle}
): SnapshotStorage {
  return new SnapshotStorage(
    directorySnapshotStore(name, opfsSnapshotDirectory(name, options?.directory)),
    options
  )
}

/**
 * Keeps snapshots as Blobs in IndexedDB database `name`, of the global
 * IndexedDB or the given implementation. See `SnapshotStorage`.
 */
export function indexedDBSnapshots(
  name: string,
  options?: SnapshotStorageOptions & Partial<IndexedDBImplementation>
): SnapshotStorage {
  const implementation =
    options?.indexedDB && options.IDBKeyRange
      ? {indexedDB: options.indexedDB, IDBKeyRange: options.IDBKeyRange}
      : undefined
  return new SnapshotStorage(indexedDBSnapshotStore(name, implementation), options)
}

/**
 * Keeps snapshots in memory, in a `memorySnapshotStore`: for tests, and for
 * Node and Bun. Pass the same `store` to storages that should share their
 * snapshots. See `SnapshotStorage`.
 */
export function memorySnapshots(
  store: SnapshotStore = memorySnapshotStore()
): SnapshotStorage {
  return new SnapshotStorage(store)
}

/** The snapshot a database reads, kept as `db.base`. */
interface Base extends SnapshotInfo {
  source: BaseSource
}

function infoOf(base: Base | undefined): SnapshotInfo | undefined {
  if (!base) return undefined
  const {key, branch, meta, createdAt, size} = base
  return {key, branch, meta, createdAt, size}
}

/** Which snapshot to open, and how the session saves. */
export interface OpenOptions {
  /**
   * Open the head (newest snapshot) of this branch, and save to it.
   * Default: the head of all branches, and its branch.
   */
  branch?: string
  /** Open this snapshot instead of a head */
  key?: string
  /** With `branch`: if it has no snapshots, open the head of all branches */
  fallback?: 'any-branch'
  /** Save by itself, see `AutoSaveOptions` */
  autoSave?: AutoSaveOptions
}

/** How a session wraps a database it did not open, see `storage.session`. */
export interface SessionOptions {
  /** Default: the branch of the snapshot the database reads, or `''` */
  branch?: string
  autoSave?: AutoSaveOptions
}

/**
 * When a session saves by itself: `after` milliseconds after the last
 * commit (each commit restarts the wait), and/or as soon as it holds
 * `maxHeld` bytes of changed pages, which bounds the memory a large import
 * or reindex holds. Off unless one of them is given. A save never starts
 * inside a transaction (the commit that ends it counts), and one runs at a
 * time. Stops when the session closes.
 */
export interface AutoSaveOptions {
  /** Save this many milliseconds after the last commit */
  after?: number
  /** Save once the database holds this many bytes of changed pages */
  maxHeld?: number
  /**
   * The key of the new snapshot, or `undefined` to skip this save, for
   * example while the database is between two consistent states. Default:
   * a key of its own for every save. Keys by content let Workers that
   * reach the same content share one snapshot.
   */
  key?: (db: Database) => string | undefined
  meta?: (db: Database) => SnapshotMeta
  /** Called with the errors of saves (default: `reportError`) */
  onError?: (error: unknown) => void
}

export interface SaveOptions {
  /**
   * Default: a key of its own. Key snapshots by their content where you
   * can: a key that exists is not written again, see `SaveResult`.
   */
  key?: string
  /** Default: the session's branch, which becomes this one */
  branch?: string
  meta?: SnapshotMeta
}

/**
 * What a save did. `written`: it wrote a new snapshot, which the database
 * reads now. `joined`: the key existed and holds the committed state of
 * the database byte for byte (the same commits on the same snapshot), so
 * the database reads it now, as if it had written it. `mismatch`: the key
 * existed with other content; nothing was written, and the database stays
 * as it was. `snapshot` is the snapshot under the key, if it could be read.
 */
export type SaveResult =
  | {status: 'written' | 'joined'; snapshot: SnapshotInfo}
  | {status: 'mismatch'; snapshot: SnapshotInfo | undefined}

export interface RetainPolicy {
  /** How many snapshots each branch keeps, newest first (default: 1) */
  perBranch?: number
  /** How many branches keep snapshots, those with the newest heads (default: all) */
  branches?: number
  /** Keys that are never deleted */
  pinned?: Iterable<string>
}

/** Names of the "js" VFS files snapshots are registered as */
let nextFile = 0

function checkHeader(header: Uint8Array, size: number, key: string) {
  const corrupt = (reason: string) =>
    new SQLiteError(`Snapshot "${key}" is corrupt: ${reason}`, SQLITE_CORRUPT)
  const magic = 'SQLite format 3\0'
  if (size < 512) throw corrupt(`too small (${size} bytes)`)
  for (let i = 0; i < magic.length; i++)
    if (header[i] !== magic.charCodeAt(i)) throw corrupt('not a database')
  const view = new DataView(header.buffer, header.byteOffset, 100)
  const field = view.getUint16(16)
  const pageSize = field === 1 ? 65536 : field
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0)
    throw corrupt(`invalid page size ${field}`)
  // The page count is valid if written with the change counter.
  const pageCount = view.getUint32(28)
  const stored = Math.ceil(size / pageSize)
  if (view.getUint32(92) === view.getUint32(24) && pageCount > stored)
    throw corrupt(`${pageCount} pages in the header, ${stored} in the snapshot`)
}

async function read(source: BaseSource, start: number, end: number) {
  const part = slice(source, start, end)
  return part instanceof Uint8Array
    ? part
    : new Uint8Array(await part.arrayBuffer())
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  const aligned = a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0
  const words = aligned ? a.length >> 2 : 0
  const x = new Uint32Array(a.buffer, a.byteOffset, words)
  const y = new Uint32Array(b.buffer, b.byteOffset, words)
  for (let i = 0; i < words; i++) if (x[i] !== y[i]) return false
  for (let i = words * 4; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** If `source` holds exactly what writing `snapshot` would write. */
async function holds(source: BaseSource, snapshot: NewSnapshot) {
  const {size, visible, chunkSize, pages} = snapshot
  if (size === 0 || sizeOf(source) !== size) return false
  const step = Math.max(1, Math.floor(WRITE_BYTES / chunkSize)) * chunkSize
  let i = 0
  for (let at = 0; at < size; at += step) {
    const end = Math.min(at + step, size)
    const actual = await read(source, at, end)
    const expected = new Uint8Array(end - at)
    if (snapshot.base && at < visible)
      expected.set(await read(snapshot.base, at, Math.min(end, visible)))
    // Pages are views of Wasm memory: take them after the last await.
    for (; i < pages.length && pages[i] * chunkSize < end; i++) {
      const start = pages[i] * chunkSize
      expected.set(snapshot.page(i).subarray(0, end - start), start - at)
    }
    if (!equal(actual, expected)) return false
  }
  return true
}

const newestFirst = (a: SnapshotInfo, b: SnapshotInfo) =>
  b.createdAt - a.createdAt

function wholeNumber(name: string, value: number, min: number) {
  if (value !== Infinity && (!Number.isInteger(value) || value < min))
    throw new RangeError(`${name} must be a whole number of at least ${min}, not ${value}`)
}

/**
 * Databases on immutable snapshots, kept by a `SnapshotStore`: files in
 * OPFS (`opfsSnapshots`), Blobs in IndexedDB (`indexedDBSnapshots`) or bytes
 * in memory (`memorySnapshots`). Any number of Workers, dedicated or
 * shared, open a database on the same snapshot at once; SQLite reads its
 * pages as it needs them, and keeps every change in the Worker's memory.
 * `session.save()` writes those changes to a new snapshot.
 *
 * ```ts
 * import {init} from '@alinea/sqlite-wasm'
 * import {opfsSnapshots} from '@alinea/sqlite-wasm/snapshots'
 *
 * const {Database} = await init()
 * const storage = opfsSnapshots('entries')
 * const session = await storage.open(Database, {branch: 'config-1'})
 * session.db.run('create table if not exists notes (text)')
 * await session.save({key: 'tree-2'})
 * await storage.retain()
 * ```
 */
export class SnapshotStorage {
  private locks: Pick<LockManager, 'request'> | null

  constructor(
    public readonly store: SnapshotStore,
    options?: SnapshotStorageOptions
  ) {
    this.locks =
      options?.locks !== undefined
        ? options.locks
        : store.locking
          ? (globalThis.navigator?.locks ?? null)
          : null
  }

  /** If snapshots can be read and written in this context. */
  supported(): boolean {
    return this.store.supported()
  }

  /**
   * Every snapshot, or those of `branch`, newest first. A snapshot of size
   * 0 is being written, or writing it failed.
   */
  async list(filter: {branch?: string} = {}): Promise<Array<SnapshotInfo>> {
    const all = (await this.store.list()).sort(newestFirst)
    const {branch} = filter
    return branch === undefined ? all : all.filter(s => s.branch === branch)
  }

  /** The newest snapshot of `branch`, or of all, if there is one. */
  async head(branch?: string): Promise<SnapshotInfo | undefined> {
    if (this.store.head) {
      const head = await this.store.head(branch)
      if (!head || head.size > 0) return head
    }
    return (await this.list({branch})).find(snapshot => snapshot.size > 0)
  }

  private lockName(kind: 'read' | 'write', key: string) {
    return JSON.stringify(['@alinea/sqlite-wasm/snapshots', this.store.name, kind, key])
  }

  /**
   * Hold a shared lock on reading snapshot `key`, which keeps `retain` from
   * deleting it, until the returned function is called.
   * @internal
   */
  hold(key: string): Promise<() => void> {
    const locks = this.locks
    if (!locks) return Promise.resolve(() => {})
    return new Promise((resolve, reject) => {
      locks
        .request(this.lockName('read', key), {mode: 'shared'}, () =>
          new Promise<void>(release => resolve(release))
        )
        .catch(reject)
    })
  }

  /** Run `write` while no other Worker writes snapshot `key`. @internal */
  exclusive<T>(key: string, write: () => Promise<T>): Promise<T> {
    if (!this.locks) return write()
    return this.locks.request(this.lockName('write', key), write)
  }

  /**
   * Open a session on snapshot `key`, or on the head of `branch` (of all
   * branches if it has none and `fallback` is `'any-branch'`), or on the
   * head of all; `session.snapshot` tells which. Pages are read from the
   * snapshot as queries need them, and every change is kept in memory:
   * `session.save()` writes them to a new snapshot, and they are lost when
   * the session closes without saving or the Worker ends. SQLite keeps up
   * to 8 MB of the pages it read in its page cache (`PRAGMA cache_size`,
   * also for forks). Without a snapshot to open, the database starts empty.
   * Rejects with `SQLITE_CANTOPEN` if snapshot `key` does not exist, and
   * with `SQLITE_CORRUPT` if it is not a database.
   */
  async open<T extends Database>(
    Database: new () => T,
    options: OpenOptions = {}
  ): Promise<Session<T>> {
    const {key, branch, fallback, autoSave} = options
    const head = async () =>
      (await this.head(branch)) ??
      (fallback === 'any-branch' && branch !== undefined
        ? await this.head()
        : undefined)
    for (let attempt = 0; ; attempt++) {
      const found = key ?? (await head())?.key
      if (found === undefined)
        return this.session(new Database(), {branch, autoSave})
      try {
        const db = await this.openSnapshot(Database, found)
        return this.session(db, {branch, autoSave})
      } catch (error) {
        // The head was deleted after it was found: a newer one replaced it.
        const missing = (error as SQLiteError)?.resultCode === SQLITE_CANTOPEN
        if (key !== undefined || !missing || attempt >= 2) throw error
      }
    }
  }

  /**
   * A session for `db`, a database this storage did not open, such as one
   * loaded from bytes or a fork: its first save writes all of it. Fails with
   * `SQLITE_MISUSE` for a database stored elsewhere, such as in IndexedDB
   * storage.
   */
  session<T extends Database>(db: T, options: SessionOptions = {}): Session<T> {
    if (db.file !== undefined || db.persistence)
      throw new SQLiteError('Database is stored elsewhere', SQLITE_MISUSE)
    return new Session(this, db, options)
  }

  private async openSnapshot<T extends Database>(
    Database: new () => T,
    key: string
  ): Promise<T> {
    const release = once(await this.hold(key))
    let db: T | undefined
    try {
      const found = await this.store.get(key)
      if (!found || sizeOf(found.source) === 0)
        throw new SQLiteError(`No snapshot "${key}"`, SQLITE_CANTOPEN)
      const {info, source} = found
      checkHeader(await read(source, 0, 100), sizeOf(source), key)
      db = new Database()
      const opened = db
      const files = filesOf(opened.wasm)
      const file = `snapshots/${nextFile++}/${key}`
      files.add(file, readOnlyFile(source), release)
      try {
        opened.openBase(file)
        opened.base = {...info, key, source} satisfies Base
      } finally {
        // Opening failed before SQLite opened the file.
        if (files.openHandles(file) === 0) files.remove(file)
      }
      try {
        db.exec('select count(*) from sqlite_schema')
        db.run(`pragma cache_size = -${CACHE_KIB}`)
      } catch (error) {
        throw new SQLiteError(
          `Snapshot "${key}" is corrupt: ${(error as Error).message}`,
          SQLITE_CORRUPT,
          {cause: error}
        )
      }
      return db
    } catch (error) {
      try {
        db?.close()
      } catch {}
      release()
      throw error
    }
  }

  /**
   * Write snapshot `key` from `snapshot` (a fork of `db` taken when the save
   * was called), or find it written with the same content, and move `db`
   * onto it, with the later snapshots of `db` that wait for their turn:
   * they read the same snapshot as `db` until then. Those that read
   * another one by now (when moving one failed) stay where they are, as
   * does `db` once it is closed.
   * @internal
   */
  async write(
    db: Database,
    snapshot: Database,
    waiting: Set<Database>,
    {key, branch, meta}: {key: string; branch: string; meta: SnapshotMeta}
  ): Promise<SaveResult> {
    const release = once(await this.hold(key))
    let registered = false
    try {
      const written = await this.exclusive(key, () =>
        this.store.write(newSnapshot(snapshot, key, branch, meta))
      )
      let target: Base | undefined
      if (written) {
        // Only for its time: the fallback is close enough if reading fails.
        const stored = await this.store.get(key).catch(() => undefined)
        target = {
          ...(stored?.info ?? {
            key,
            branch,
            meta,
            createdAt: now(),
            size: sizeOf(written)
          }),
          source: written
        }
      } else {
        const found = await this.existing(snapshot, key)
        if (found.status !== 'move') {
          release()
          return {status: found.status, snapshot: found.info} as SaveResult
        }
        target = found.base
      }
      const from = snapshot.base
      const files = filesOf(db.wasm)
      const file = `snapshots/${nextFile++}/${key}`
      // From here on, the lock is released once nothing reads the file.
      files.add(file, readOnlyFile(target.source), release)
      registered = true
      try {
        if (!db.isClosed() && db.base === from) {
          db.rebase(snapshot, file)
          db.base = target
        }
        for (const later of waiting) {
          if (later === snapshot || later.base !== from) continue
          try {
            later.rebase(snapshot, file)
            later.base = target
          } catch {
            // It writes from the snapshot it reads, and db stays on that.
          }
        }
      } finally {
        if (files.openHandles(file) === 0) files.remove(file)
      }
      return {status: written ? 'written' : 'joined', snapshot: infoOf(target)!}
    } catch (error) {
      if (!registered) release()
      throw error
    }
  }

  /**
   * What to do with snapshot `key`, which exists: move onto it if it holds
   * exactly the committed state of `snapshot`, nothing if `snapshot` reads
   * it already with nothing changed, else nothing either: a mismatch.
   */
  private async existing(
    snapshot: Database,
    key: string
  ): Promise<
    | {status: 'move'; base: Base; info?: undefined}
    | {status: 'joined' | 'mismatch'; info: SnapshotInfo | undefined}
  > {
    const current = snapshot.base as Base | undefined
    try {
      // A key names content, but other Workers may have stored the same
      // rows in other pages, under which the pages a database holds would
      // not fit.
      const content = newSnapshot(snapshot, key, '', {})
      if (current?.key === key) {
        const unchanged =
          content.pages.length === 0 && content.size === sizeOf(current.source)
        return {status: unchanged ? 'joined' : 'mismatch', info: infoOf(current)}
      }
      const found = await this.store.get(key)
      if (!found) return {status: 'mismatch', info: undefined}
      if (!(await holds(found.source, content)))
        return {status: 'mismatch', info: found.info}
      return {status: 'move', base: {...found.info, source: found.source}}
    } catch {
      // Deleted while it was read: the database stays where it is.
      return {status: 'mismatch', info: undefined}
    }
  }

  /**
   * Delete snapshots by `policy`: each branch keeps its newest `perBranch`
   * (default 1), only the `branches` with the newest heads keep any
   * (default: all), and `pinned` keys are always kept. With locks (OPFS),
   * snapshots a database reads are kept too; without, OPFS keeps one more
   * per branch, as a Worker may still read it, and deletes snapshots of the
   * branches past `branches` that Workers may still read. IndexedDB, whose
   * Blobs stay readable, needs neither. Empty snapshots are being written,
   * or writing them failed: with locks, those nobody writes are deleted,
   * without, those older than an hour. Resolves to the deleted keys.
   */
  async retain(policy: RetainPolicy = {}): Promise<Array<string>> {
    const {perBranch = 1, branches = Infinity} = policy
    wholeNumber('perBranch', perBranch, 1)
    wholeNumber('branches', branches, 0)
    const pinned = new Set(policy.pinned ?? [])
    const all = await this.list()
    const ranked: Array<string> = []
    for (const snapshot of all) {
      if (snapshot.size > 0 && !ranked.includes(snapshot.branch))
        ranked.push(snapshot.branch)
    }
    const kept = new Set(ranked.slice(0, branches))
    const seen = new Map<string, number>()
    const keep = perBranch + (this.locks || this.store.keepsRemoved ? 0 : 1)
    const deleted: Array<string> = []
    for (const snapshot of all) {
      if (pinned.has(snapshot.key)) continue
      if (snapshot.size > 0) {
        const count = (seen.get(snapshot.branch) ?? 0) + 1
        seen.set(snapshot.branch, count)
        if (count <= keep && kept.has(snapshot.branch)) continue
      } else if (!this.locks && now() - snapshot.createdAt < STALE_MS) {
        // Empty snapshots are being written, which locks them, or writing
        // them failed. Without locks, only the ones that are old have failed.
        continue
      }
      if (!this.locks) {
        await this.store.remove(snapshot.key)
        deleted.push(snapshot.key)
        continue
      }
      await this.locks.request(
        this.lockName('read', snapshot.key),
        {mode: 'exclusive', ifAvailable: true},
        async lock => {
          if (!lock) return
          await this.store.remove(snapshot.key)
          deleted.push(snapshot.key)
        }
      )
    }
    return deleted
  }
}

/**
 * A database on a snapshot storage: `db` reads `snapshot` and holds what
 * changed since in memory, until `save()` writes a new snapshot on
 * `branch`. Close it with `close()`, which also stops automatic saves.
 */
export class Session<D extends Database = Database> {
  #storage: SnapshotStorage
  #branch: string
  /** Saves run one after the other */
  #queue: Promise<unknown> = Promise.resolve()
  /** Snapshots of the saves that wait for their turn or run */
  #waiting = new Set<Database>()
  #stopAutoSave = () => {}

  /** @internal Use `storage.open()` or `storage.session()`. */
  constructor(
    storage: SnapshotStorage,
    readonly db: D,
    options: SessionOptions = {}
  ) {
    this.#storage = storage
    this.#branch =
      options.branch ?? (db.base as Base | undefined)?.branch ?? ''
    if (options.autoSave) this.#stopAutoSave = this.#autoSave(options.autoSave)
  }

  /** The branch saves go to, unless they name another */
  get branch(): string {
    return this.#branch
  }

  /**
   * The snapshot the database reads (after a save, the one it wrote or
   * joined), or `undefined` if it has none.
   */
  get snapshot(): SnapshotInfo | undefined {
    return infoOf(this.db.base as Base | undefined)
  }

  /** Bytes of changed pages the database holds in memory */
  get held(): number {
    const [[pages]] = this.db.exec('pragma overlay_pages')[0].values
    const [[pageSize]] = this.db.exec('pragma page_size')[0].values
    return Number(pages) * Number(pageSize)
  }

  /**
   * Write the committed state of the database to a new snapshot, and have
   * it read that from now on: the pages it holds that did not change since
   * are dropped from memory. The database keeps working meanwhile; changes
   * made after the save started stay in memory. The state is taken when
   * `save` is called; saves of a session are written one at a time. See
   * `SaveResult` for a key that exists. Fails with `SQLITE_BUSY` during a
   * write transaction.
   */
  save(options: SaveOptions = {}): Promise<SaveResult> {
    let snapshot: Database
    try {
      snapshot = this.db.fork()
    } catch (error) {
      return Promise.reject(
        new SQLiteError((error as Error).message, SQLITE_BUSY, {cause: error})
      )
    }
    if (options.branch !== undefined) this.#branch = options.branch
    const target = {
      key: options.key ?? uniqueKey(),
      branch: this.#branch,
      meta: options.meta ?? {}
    }
    const waiting = this.#waiting
    waiting.add(snapshot)
    const next = this.#queue
      .catch(() => {})
      .then(() => this.#storage.write(this.db, snapshot, waiting, target))
      .finally(() => {
        waiting.delete(snapshot)
        snapshot.close()
      })
    this.#queue = next
    return next
  }

  /**
   * A new session on a fork of the database: it reads the same snapshot,
   * starts with the same changes and branch, and keeps its own from then on.
   */
  fork(): Session<D> {
    return new Session(this.#storage, this.db.fork(), {branch: this.#branch})
  }

  /**
   * Stop saving automatically and close the database; with `save`, save
   * first. Changes that were not saved are lost. Resolves once every save
   * has finished.
   */
  async close(options: {save?: SaveOptions} = {}): Promise<void> {
    this.#stopAutoSave()
    try {
      if (options.save && !this.db.isClosed()) await this.save(options.save)
    } finally {
      if (!this.db.isClosed()) this.db.close()
      await this.#queue.catch(() => {})
    }
  }

  #autoSave(options: AutoSaveOptions): () => void {
    const {after, maxHeld} = options
    const db = this.db
    const report =
      options.onError ??
      ((error: unknown) =>
        typeof reportError === 'function'
          ? reportError(error)
          : console.error(error))
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let checking = false
    let running = false
    let again = false
    const active = () => {
      if (stopped || db.isClosed()) stop()
      return !stopped
    }
    const run = () => {
      clearTimeout(timer)
      timer = undefined
      if (!active()) return
      if (running) {
        again = true
        return
      }
      if (db.inTransaction()) return
      let key: string | undefined
      let meta: SnapshotMeta | undefined
      try {
        key = options.key ? options.key(db) : uniqueKey()
        if (key === undefined) return
        meta = options.meta?.(db)
      } catch (error) {
        report(error)
        return
      }
      running = true
      this.save({key, meta})
        .catch(report)
        .finally(() => {
          running = false
          if (again) {
            again = false
            run()
          }
        })
    }
    // Called inside each commit: only schedule.
    const committed = () => {
      if (after !== undefined) {
        clearTimeout(timer)
        timer = setTimeout(run, after)
      }
      if (maxHeld !== undefined && !checking) {
        checking = true
        setTimeout(() => {
          checking = false
          if (active() && !db.inTransaction() && this.held >= maxHeld) run()
        }, 0)
      }
    }
    const unwatch =
      after === undefined && maxHeld === undefined
        ? () => {}
        : db.watchCommits(committed)
    const stop = () => {
      stopped = true
      clearTimeout(timer)
      unwatch()
    }
    return stop
  }
}

function newSnapshot(
  snapshot: Database,
  key: string,
  branch: string,
  meta: SnapshotMeta
): NewSnapshot {
  const {chunkSize, size, visible, pages} = snapshot.pages()
  const base = snapshot.base as Base | undefined
  if (visible > 0 && !base)
    throw new SQLiteError(
      'Database reads a snapshot it was not opened on',
      SQLITE_MISUSE
    )
  // The snapshot is not used meanwhile, so its pages stay where they are,
  // but the Wasm heap may grow: take HEAPU8 afresh.
  return {
    key,
    branch,
    meta,
    base: base?.source,
    visible,
    size,
    chunkSize,
    pages: pages.map(([index]) => index),
    page(i) {
      const pointer = pages[i][1]
      return snapshot.wasm.HEAPU8.subarray(pointer, pointer + chunkSize)
    }
  }
}

/** A key no other save uses */
function uniqueKey() {
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function once(action: () => void) {
  let done = false
  return () => {
    if (done) return
    done = true
    action()
  }
}
