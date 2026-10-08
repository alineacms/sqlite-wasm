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
// Blob reads of snapshots: bytes read at once, and how many such blocks are
// kept, see readOnlyFile
const BLOCK_BYTES = 1 << 20
const CACHED_BLOCKS = 4
// Saves write the pages that changed over the snapshot they read, as a
// delta, while at most this many deltas lie on a full snapshot (see
// maxDepth), its pages take at most half the bytes of the database, and
// those of all of them no more than the database: reads look through every
// delta, and deltas keep pages the ones above replace.
const MAX_DEPTH = 8
// The most deltas a snapshot can lie over, whatever maxDepth was
const MAX_CHAIN = 64
// Without locks, how old an empty base is before cleanup deletes it: one
// that is still being written after this long has failed.
const STALE_MS = 60 * 60_000

/** Content that does not change: a `File` or `Blob`, or bytes. */
export type BaseSource = Blob | Uint8Array

/** How a read-only file reads a Blob, see `readOnlyFile`. */
export interface ReadOnlyFileOptions {
  /** Bytes per block read at once, a power of two (default: 1 MiB) */
  blockSize?: number
  /** How many blocks are kept (default: 4) */
  blocks?: number
}

/**
 * A read-only `SyncFile` over `source`. Blobs, such as the `File` of an
 * OPFS file or a Blob read from IndexedDB, are read synchronously with
 * `FileReaderSync`, which Workers have (not the main thread).
 *
 * Each `FileReaderSync` read costs about a millisecond however little it
 * reads, so a Blob is read in blocks where that pays: a read that starts
 * where the previous one ended, or shortly after, reads the whole block it
 * starts in, which is kept for the reads that follow (the newest `blocks`
 * are). Scans read a block at a time; reads in random order, such as point
 * lookups and lookups through an index, read only what they ask for.
 */
export function readOnlyFile(
  source: BaseSource,
  options: ReadOnlyFileOptions = {}
): SyncFile {
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
    const size = source.size
    const blockSize = options.blockSize ?? BLOCK_BYTES
    const capacity = options.blocks ?? CACHED_BLOCKS
    // Blocks by index, least recently used first
    const cached = new Map<number, Uint8Array>()
    // Where the previous read ended
    let previousEnd = -1
    const readRange = (start: number, end: number) =>
      new Uint8Array(reader.readAsArrayBuffer(source.slice(start, end)))
    const block = (index: number) => {
      let data = cached.get(index)
      if (data) {
        cached.delete(index)
      } else {
        const start = index * blockSize
        data = readRange(start, Math.min(start + blockSize, size))
        if (cached.size >= capacity && capacity > 0)
          cached.delete(cached.keys().next().value!)
      }
      if (capacity > 0) cached.set(index, data)
      return data
    }
    read = (buffer, at) => {
      const end = Math.min(at + buffer.length, size)
      if (end <= at) return 0
      const first = Math.floor(at / blockSize)
      const last = Math.floor((end - 1) / blockSize)
      let whole = capacity > 0 && at >= previousEnd && at < previousEnd + blockSize
      if (!whole) {
        whole = true
        for (let i = first; i <= last; i++) if (!cached.has(i)) whole = false
      }
      previousEnd = end
      if (!whole) {
        buffer.set(readRange(at, end))
        return end - at
      }
      for (let i = first; i <= last; i++) {
        const start = i * blockSize
        const data = block(i)
        const from = Math.max(at, start)
        const to = Math.min(end, start + data.length)
        buffer.set(data.subarray(from - start, to - start), from - at)
      }
      return end - at
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

/**
 * Open a database over `base`, a database file that does not change while
 * it is open: SQLite reads its pages as queries need them, and every change
 * stays in memory, as with a snapshot. `db.fork()` is as cheap as for
 * snapshots. `base` is a read-only `SyncFile`, such as one of
 * `readOnlyFileAt(path)` from `@alinea/sqlite-wasm/file` in Node and Bun,
 * or a `File`, `Blob` or bytes. The file is closed once the database and
 * its forks are. Fails with `SQLITE_CORRUPT` if it is not a database.
 *
 * ```ts
 * import {readOnlyFileAt} from '@alinea/sqlite-wasm/file'
 * import {openOverlay} from '@alinea/sqlite-wasm/snapshots'
 *
 * const db = openOverlay(Database, readOnlyFileAt('generated.db'))
 * ```
 */
export function openOverlay<T extends Database>(
  Database: new () => T,
  base: SyncFile | BaseSource
): T {
  const file =
    base instanceof Uint8Array || base instanceof Blob ? readOnlyFile(base) : base
  return openOn(Database, file, file.getSize(), 'Database', () => file.close())
}

/**
 * Open a database on `file`, `size` bytes, which reads `name` in errors.
 * `release` is called once, when the database and its forks closed or if
 * opening fails.
 */
function openOn<T extends Database>(
  Database: new () => T,
  file: SyncFile,
  size: number,
  name: string,
  release: () => void
): T {
  release = once(release)
  let db: T | undefined
  try {
    const header = new Uint8Array(100)
    file.read(header, {at: 0})
    checkHeader(header, size, name)
    db = new Database()
    const files = filesOf(db.wasm)
    const label = `bases/${nextFile++}`
    files.add(label, file, release)
    try {
      db.openBase(label)
    } finally {
      // Opening failed before SQLite opened the file: this releases it.
      if (files.openHandles(label) === 0) files.remove(label)
    }
    try {
      db.exec('select count(*) from sqlite_schema')
      db.run(`pragma cache_size = -${CACHE_KIB}`)
    } catch (error) {
      throw new SQLiteError(`${name} is corrupt: ${(error as Error).message}`, SQLITE_CORRUPT, {
        cause: error
      })
    }
    return db
  } catch (error) {
    try {
      // Releases the file once SQLite closes it.
      db?.close()
    } catch {}
    release()
    throw error
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

/** A stored snapshot. */
export interface SnapshotInfo {
  key: string
  /** A line of snapshots; retain keeps the newest (the head) */
  branch: string
  meta: SnapshotMeta
  /** When it was written, in milliseconds since 1970 */
  createdAt: number
  /** Of the database, in bytes; 0 while it is written, or if writing failed */
  size: number
  /**
   * For a snapshot stored as the pages that changed since another, the key
   * of that one, which it needs to be read
   */
  parent?: string
}

/**
 * How a snapshot stored as changed pages lies over its parent: page
 * `pages[i]` (of `chunkSize` bytes) is the i-th page of its content, the
 * first `visible` bytes of the parent show where it has no page, and what
 * lies past them reads as zero.
 */
export interface DeltaLayout {
  parent: string
  chunkSize: number
  visible: number
  /** Ascending */
  pages: Array<number>
  /** How many deltas lie on the full snapshot below, this one included */
  depth: number
  /** Bytes of pages stored by those deltas */
  chainBytes: number
}

/** A stored snapshot, its content and, for a delta, its layout. */
export interface StoredSnapshot {
  info: SnapshotInfo
  /** The whole database, or for a delta its pages one after the other */
  source: BaseSource
  delta?: DeltaLayout
}

/** A snapshot to write: pages over (part of) an existing one. */
export interface NewSnapshot {
  key: string
  branch: string
  meta: SnapshotMeta
  /**
   * The content the pages go over, of which the first `visible` bytes stay.
   * Not needed to write a delta: read it only to write a full snapshot.
   */
  readonly base?: BaseSource
  visible: number
  /** The size of the new base; past `visible`, what no page covers is zero */
  size: number
  chunkSize: number
  /** Indexes of the pages, ascending, each starting before `size` */
  pages: Array<number>
  /**
   * The content of `pages[i]`: a view of Wasm memory, valid until the next
   * await.
   */
  page(i: number): Uint8Array
  /**
   * If set, store only the pages, as a delta over snapshot `delta.parent`
   * (see `DeltaLayout`, whose `pages` are `pages`)
   */
  delta?: Omit<DeltaLayout, 'pages' | 'chunkSize' | 'visible'>
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
  /** Snapshot `key` and its content, which stays as it is, if it exists */
  get(key: string): Promise<StoredSnapshot | undefined>
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
// What a delta file starts with, so it is never empty
const DELTA_MARKER = new TextEncoder().encode('SQLite delta\0\0\0\0')

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
  // The metadata of snapshot `key`: its time, or else `lastModified`, and
  // for a delta its size and layout
  async function readMeta(key: string, lastModified: number) {
    const source = await directory.get(encodeKey(key) + META_SUFFIX)
    let stored: {
      branch?: unknown
      meta?: SnapshotMeta
      createdAt?: unknown
      size?: unknown
      delta?: DeltaLayout
    } = {}
    try {
      if (source) stored = JSON.parse(await readText(source)) ?? {}
    } catch {}
    return {
      branch: String(stored.branch ?? ''),
      meta: stored.meta ?? {},
      createdAt:
        typeof stored.createdAt === 'number' ? stored.createdAt : lastModified,
      size: typeof stored.size === 'number' ? stored.size : undefined,
      delta: stored.delta
    }
  }
  // A file of `bytes` that was written in full: empty ones are still being
  // written, or writing them failed
  async function infoOf(key: string, bytes: number, lastModified: number) {
    const {size, delta, ...rest} = await readMeta(key, lastModified)
    const info: SnapshotInfo = {
      key,
      ...rest,
      size: bytes === 0 ? 0 : (size ?? bytes)
    }
    if (delta) info.parent = delta.parent
    return {info, delta}
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
  // Write `pages` of `snapshot` in runs of consecutive ones, page `i` at
  // `position(i)`
  async function writePages(
    writer: FileWriter,
    snapshot: NewSnapshot,
    position: (i: number) => number
  ) {
    const {chunkSize, pages} = snapshot
    const perWrite = Math.max(1, Math.floor(WRITE_BYTES / chunkSize))
    for (let i = 0; i < pages.length; ) {
      let end = i + 1
      while (
        end < pages.length &&
        end - i < perWrite &&
        position(end) === position(end - 1) + chunkSize
      )
        end++
      const run = new Uint8Array((end - i) * chunkSize)
      for (let k = i; k < end; k++)
        run.set(snapshot.page(k), (k - i) * chunkSize)
      await writer.write(run, position(i))
      i = end
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
          .map(
            async file =>
              (await infoOf(decodeKey(file.name), file.size, file.lastModified))
                .info
          )
      )
    },
    async get(key) {
      const source = await directory.get(encodeKey(key))
      if (!source) return undefined
      const lastModified =
        source instanceof Blob && 'lastModified' in source
          ? (source as File).lastModified
          : 0
      const {info, delta} = await infoOf(key, sizeOf(source), lastModified)
      if (!delta) return {info, source}
      // Pages follow the marker of a delta file.
      return {info, source: slice(source, DELTA_MARKER.length, sizeOf(source)), delta}
    },
    async write(snapshot) {
      const file = encodeKey(snapshot.key)
      const existing = await directory.get(file)
      if (existing && sizeOf(existing) > 0) return undefined
      // The empty snapshot file appears first, so the metadata is never
      // left without one.
      const writer = await directory.create(file)
      try {
        const {chunkSize, pages, visible, size, delta} = snapshot
        const meta = JSON.stringify({
          branch: snapshot.branch,
          meta: snapshot.meta,
          createdAt: now(),
          ...(delta && {
            size,
            delta: {...delta, chunkSize, visible, pages} satisfies DeltaLayout
          })
        })
        await writeFile(file + META_SUFFIX, new TextEncoder().encode(meta))
        if (delta) {
          // A marker, so the file is never empty, then the pages in order
          await writer.write(DELTA_MARKER, 0)
          await writePages(writer, snapshot, i => DELTA_MARKER.length + i * chunkSize)
        } else {
          const base = snapshot.base
          if (base && visible > 0) {
            if (sizeOf(base) < visible)
              throw new SQLiteError('Snapshot is too short', SQLITE_IOERR_READ)
            await writer.copy(slice(base, 0, visible))
          }
          await writer.truncate(visible)
          await writePages(writer, snapshot, i => pages[i] * chunkSize)
          await writer.truncate(size)
        }
        await writer.close()
      } catch (error) {
        await writer.abort().catch(() => {})
        await directory.remove(file + META_SUFFIX).catch(() => {})
        throw error
      }
      const written = await directory.get(file)
      return written && snapshot.delta
        ? slice(written, DELTA_MARKER.length, sizeOf(written))
        : written
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

/** A snapshot as IndexedDB stores it. */
interface BaseRecord extends SnapshotInfo {
  /** The database, or for a delta its pages one after the other */
  blob: Blob
  delta?: DeltaLayout
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
  const info = ({key, branch, meta, createdAt, size, delta}: BaseRecord) => {
    const info: SnapshotInfo = {key, branch, meta, createdAt, size}
    if (delta) info.parent = delta.parent
    return info
  }
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
      return record && {info: info(record), source: record.blob, delta: record.delta}
    },
    async write(base) {
      if (await request((await store('readonly')).count(base.key))) return
      const {chunkSize, visible, pages, delta} = base
      // The Blob copies the pages out of Wasm memory.
      const blob = delta
        ? new Blob(pages.map((_, i) => base.page(i) as Uint8Array<ArrayBuffer>))
        : composeBlob(base)
      const record: BaseRecord = {
        key: base.key,
        branch: base.branch,
        meta: base.meta,
        createdAt: now(),
        size: base.size,
        blob
      }
      if (delta) record.delta = {...delta, chunkSize, visible, pages}
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
  const bases = new Map<
    string,
    {info: SnapshotInfo; data: Uint8Array; delta?: DeltaLayout}
  >()
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
      // The bytes are shared: snapshots are never written.
      return base && {info: copy(base.info), source: base.data, delta: base.delta}
    },
    async write(snapshot) {
      if (bases.has(snapshot.key)) return undefined
      const {chunkSize, visible, size, pages, delta} = snapshot
      let data: Uint8Array
      if (delta) {
        data = new Uint8Array(pages.length * chunkSize)
        pages.forEach((_, i) => data.set(snapshot.page(i), i * chunkSize))
      } else {
        data = new Uint8Array(size)
        const keep = Math.min(visible, size)
        const base = snapshot.base
        if (base && keep > 0) {
          const part = slice(base, 0, keep)
          data.set(
            part instanceof Uint8Array
              ? part
              : new Uint8Array(await part.arrayBuffer())
          )
        }
        // Bytes past `visible` that no page covers stay zero.
        pages.forEach((index, i) => {
          const start = index * chunkSize
          data.set(snapshot.page(i).subarray(0, size - start), start)
        })
      }
      if (bases.has(snapshot.key)) return undefined
      // Times that differ, also within a millisecond
      const createdAt = (last = Math.max(now(), last + 0.001))
      const {key, branch, meta} = snapshot
      const info: SnapshotInfo = {key, branch, meta, createdAt, size}
      if (delta) info.parent = delta.parent
      bases.set(key, {
        info: copy(info),
        data,
        delta: delta && {...delta, chunkSize, visible, pages}
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
  /**
   * How many deltas may lie on a full snapshot (default: 8). A save writes
   * only the pages that changed, over the snapshot the database reads,
   * while that keeps at most this many deltas, its pages are at most half
   * the database, and those of all of them no more than the database; else
   * it writes the whole database. 0 writes every snapshot in full.
   */
  maxDepth?: number
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
  store: SnapshotStore = memorySnapshotStore(),
  options?: SnapshotStorageOptions
): SnapshotStorage {
  return new SnapshotStorage(store, options)
}

/** A stored snapshot and, for a delta, the one it lies over. */
interface Layer extends StoredSnapshot {
  below?: Layer
}

/** The snapshot a database reads, kept as `db.base`. */
interface Base extends SnapshotInfo {
  layer: Layer
  /** Of this snapshot and those it lies over, top first */
  keys: Array<string>
  /** Deltas from the full snapshot below, and the bytes they store */
  depth: number
  chainBytes: number
  /** The whole database, composed of the layers where needed */
  content(): BaseSource
  /** A file that reads it */
  file(): SyncFile
}

function baseOf(layer: Layer): Base {
  const keys: Array<string> = []
  for (let at: Layer | undefined = layer; at; at = at.below) keys.push(at.info.key)
  return {
    ...layer.info,
    layer,
    keys,
    depth: layer.delta?.depth ?? 0,
    chainBytes: layer.delta?.chainBytes ?? 0,
    // Only needed to write in full or compare: not kept, as for bytes it
    // copies the database.
    content: () => layerContent(layer),
    file: () => layerFile(layer)
  }
}

function infoOf(base: Base | undefined): SnapshotInfo | undefined {
  if (!base) return undefined
  const {key, branch, meta, createdAt, size, parent} = base
  const info: SnapshotInfo = {key, branch, meta, createdAt, size}
  if (parent !== undefined) info.parent = parent
  return info
}

/** A run of bytes of a delta: its own pages, the layer below, or zeros */
type Run =
  | {kind: 'own'; from: number; to: number; at: number}
  | {kind: 'below' | 'zero'; from: number; to: number}

const slotsOf = new WeakMap<DeltaLayout, Map<number, number>>()

/** The runs bytes `start` to `end` of a delta are read from */
function* runs(delta: DeltaLayout, start: number, end: number): Generator<Run> {
  let slots = slotsOf.get(delta)
  if (!slots) {
    slots = new Map(delta.pages.map((page, slot) => [page, slot]))
    slotsOf.set(delta, slots)
  }
  const {chunkSize, visible} = delta
  for (let p = start; p < end; ) {
    const chunk = Math.floor(p / chunkSize)
    const slot = slots.get(chunk)
    let next = chunk + 1
    let to: number
    if (slot !== undefined) {
      // Consecutive pages that are stored one after the other
      while (next * chunkSize < end && slots.get(next) === slot + next - chunk) next++
      to = Math.min(next * chunkSize, end)
      yield {kind: 'own', from: p, to, at: slot * chunkSize + p - chunk * chunkSize}
    } else if (p < visible) {
      while (next * chunkSize < Math.min(end, visible) && !slots.has(next)) next++
      to = Math.min(next * chunkSize, end, visible)
      yield {kind: 'below', from: p, to}
    } else {
      while (next * chunkSize < end && !slots.has(next)) next++
      to = Math.min(next * chunkSize, end)
      yield {kind: 'zero', from: p, to}
    }
    p = to
  }
}

/** Files of layers, so files over the same ones share their block caches */
const layerFiles = new WeakMap<Layer, SyncFile>()

/** A read-only file of the database a layer holds */
function layerFile(layer: Layer): SyncFile {
  let file = layerFiles.get(layer)
  if (!file) layerFiles.set(layer, (file = createLayerFile(layer)))
  return file
}

function createLayerFile(layer: Layer): SyncFile {
  const own = readOnlyFile(layer.source)
  const {delta, below} = layer
  if (!delta || !below) return own
  const under = layerFile(below)
  const size = layer.info.size
  // Read `to - from` bytes at `at` of `file` into `buffer` at `offset`,
  // with zeros past its end
  const fill = (file: SyncFile, buffer: Uint8Array, offset: number, length: number, at: number) => {
    const part = buffer.subarray(offset, offset + length)
    const read = file.read(part, {at})
    if (read < length) part.fill(0, Math.max(0, read))
  }
  return {
    ...own,
    read(buffer, {at}) {
      const end = Math.min(at + buffer.length, size)
      if (end <= at) return 0
      for (const run of runs(delta, at, end)) {
        const length = run.to - run.from
        const offset = run.from - at
        if (run.kind === 'own') fill(own, buffer, offset, length, run.at)
        else if (run.kind === 'below') fill(under, buffer, offset, length, run.from)
        else buffer.fill(0, offset, offset + length)
      }
      return end - at
    },
    getSize: () => size
  }
}

/** The database a layer holds, as one Blob, or bytes for bytes */
function layerContent(layer: Layer): BaseSource {
  if (!layer.delta) return layer.source
  const parts: Array<BaseSource> = []
  const add = (source: BaseSource, start: number, end: number) => {
    const stored = Math.min(end, sizeOf(source))
    if (stored > start) parts.push(slice(source, start, stored))
    if (end > Math.max(start, stored)) parts.push(new Uint8Array(end - Math.max(start, stored)))
  }
  const collect = (layer: Layer, start: number, end: number) => {
    const {delta, below} = layer
    if (!delta || !below) return add(layer.source, start, end)
    for (const run of runs(delta, start, end)) {
      if (run.kind === 'own') add(layer.source, run.at, run.at + run.to - run.from)
      else if (run.kind === 'below') collect(below, run.from, run.to)
      else parts.push(new Uint8Array(run.to - run.from))
    }
  }
  collect(layer, 0, layer.info.size)
  if (parts.some(part => part instanceof Blob)) return new Blob(parts as Array<BlobPart>)
  const bytes = new Uint8Array(layer.info.size)
  let at = 0
  for (const part of parts as Array<Uint8Array>) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return bytes
}

/** Which snapshot to open, and how the session saves. */
export interface OpenOptions {
  /**
   * The branch the session saves to. Default: the branch of the snapshot
   * it opens, or `''`.
   */
  branch?: string
  /**
   * The snapshot to open, out of the readable ones, newest first, or
   * undefined to start empty. Default: the head (newest) of `branch`, or
   * of all without one. Called again without a snapshot that turns out
   * unreadable (deleted meanwhile, or lying over a missing one).
   */
  choose?: (snapshots: Array<SnapshotInfo>) => SnapshotInfo | undefined
  /** Open this snapshot, and fail if it cannot be read */
  key?: string
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

/** Check the header of a database file of `size` bytes, called `name`. */
function checkHeader(header: Uint8Array, size: number, name: string) {
  const corrupt = (reason: string) =>
    new SQLiteError(`${name} is corrupt: ${reason}`, SQLITE_CORRUPT)
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
    throw corrupt(`${pageCount} pages in the header, ${stored} in the file`)
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

/**
 * For `layer`, a delta over `current` with the pages of `snapshot`, if it
 * holds the same pages: then nothing else can differ. Undefined if it is
 * not such a delta, which takes comparing everything.
 */
function sameDelta(
  layer: Layer,
  current: Base | undefined,
  snapshot: NewSnapshot
): Promise<boolean> | undefined {
  const {delta, source} = layer
  const {pages, chunkSize, visible, size} = snapshot
  if (
    !delta ||
    !current ||
    delta.parent !== current.key ||
    delta.chunkSize !== chunkSize ||
    delta.visible !== visible ||
    layer.info.size !== size ||
    delta.pages.length !== pages.length ||
    delta.pages.some((page, i) => page !== pages[i])
  )
    return undefined
  return (async () => {
    const perRead = Math.max(1, Math.floor(WRITE_BYTES / chunkSize))
    for (let i = 0; i < pages.length; i += perRead) {
      const end = Math.min(i + perRead, pages.length)
      const stored = await read(source, i * chunkSize, end * chunkSize)
      // Pages are views of Wasm memory: take them after the last await.
      for (let k = i; k < end; k++) {
        const at = (k - i) * chunkSize
        if (!equal(stored.subarray(at, at + chunkSize), snapshot.page(k))) return false
      }
    }
    return true
  })()
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
  private maxDepth: number

  constructor(
    public readonly store: SnapshotStore,
    options?: SnapshotStorageOptions
  ) {
    this.maxDepth = options?.maxDepth ?? MAX_DEPTH
    wholeNumber('maxDepth', this.maxDepth, 0)
    if (this.maxDepth > MAX_CHAIN)
      throw new RangeError(`maxDepth must be at most ${MAX_CHAIN}, not ${this.maxDepth}`)
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

  /** Hold `hold` on each of `keys`, see `hold`. */
  private async holdAll(keys: Array<string>): Promise<() => void> {
    const releases: Array<() => void> = []
    try {
      for (const key of keys) releases.push(await this.hold(key))
    } catch (error) {
      for (const release of releases) release()
      throw error
    }
    return once(() => {
      for (const release of releases) release()
    })
  }

  /**
   * Snapshot `key` with the snapshots it lies over, holding them (see
   * `hold`) until the returned function is called; undefined if `key` does
   * not exist or is being written. Fails with `SQLITE_CANTOPEN` if one it
   * lies over is missing.
   */
  private async resolve(
    key: string
  ): Promise<{base: Base; release: () => void} | undefined> {
    const releases: Array<() => void> = []
    const release = once(() => {
      for (const release of releases) release()
    })
    try {
      const found: Array<StoredSnapshot> = []
      for (let at = key; ; ) {
        releases.push(await this.hold(at))
        const stored = await this.store.get(at)
        if (!stored || stored.info.size === 0) {
          if (at === key) {
            release()
            return undefined
          }
          throw new SQLiteError(
            `Snapshot "${key}" lies over "${at}", which is missing`,
            SQLITE_CANTOPEN
          )
        }
        found.push(stored)
        if (!stored.delta) break
        at = stored.delta.parent
        if (found.length > MAX_CHAIN + 1)
          throw new SQLiteError(`Snapshot "${key}" lies over too many`, SQLITE_CORRUPT)
      }
      let layer: Layer | undefined
      for (const stored of found.reverse()) layer = {...stored, below: layer}
      return {base: baseOf(layer!), release}
    } catch (error) {
      release()
      throw error
    }
  }

  /** Run `write` while no other Worker writes snapshot `key`. @internal */
  exclusive<T>(key: string, write: () => Promise<T>): Promise<T> {
    if (!this.locks) return write()
    return this.locks.request(this.lockName('write', key), write)
  }

  /**
   * Open a session on a snapshot: by default the head (newest) of
   * `branch`, or of all snapshots without one; `choose` picks another, and
   * `key` a given one. `session.snapshot` tells which. Pages are read from
   * the snapshot as queries need them, and every change is kept in memory:
   * `session.save()` writes them to a new snapshot on the session's branch,
   * and they are lost when the session closes without saving or the Worker
   * ends. SQLite keeps up to 8 MB of the pages it read in its page cache
   * (`PRAGMA cache_size`, also for forks). Without a snapshot to open, or
   * when none opens, the database starts empty. With `key`, rejects with
   * `SQLITE_CANTOPEN` if it cannot be read; any snapshot that is not a
   * database rejects with `SQLITE_CORRUPT`.
   *
   * ```ts
   * // The head of this config's branch, else the newest of any config
   * const session = await storage.open(Database, {
   *   branch: config,
   *   choose: snapshots =>
   *     snapshots.find(s => s.branch === config) ?? snapshots[0]
   * })
   * ```
   */
  async open<T extends Database>(
    Database: new () => T,
    options: OpenOptions = {}
  ): Promise<Session<T>> {
    const {key, branch, choose, autoSave} = options
    const session = (db: T) => this.session(db, {branch, autoSave})
    if (key !== undefined) return session(await this.openSnapshot(Database, key))
    const unreadable = new Set<string>()
    const attempt = async (chosen: SnapshotInfo) => {
      try {
        return await this.openSnapshot(Database, chosen.key)
      } catch (error) {
        // Deleted after it was listed, or a snapshot it lies over was
        if ((error as SQLiteError)?.resultCode !== SQLITE_CANTOPEN) throw error
        unreadable.add(chosen.key)
        return undefined
      }
    }
    // The head is found without listing every snapshot.
    if (!choose) {
      const head = await this.head(branch)
      if (!head) return session(new Database())
      const db = await attempt(head)
      if (db) return session(db)
    }
    const pick =
      choose ??
      ((snapshots: Array<SnapshotInfo>) =>
        branch === undefined ? snapshots[0] : snapshots.find(s => s.branch === branch))
    for (;;) {
      const readable = (await this.list()).filter(s => s.size > 0 && !unreadable.has(s.key))
      const chosen = pick(readable)
      if (!chosen) return session(new Database())
      if (unreadable.has(chosen.key)) return session(new Database())
      const db = await attempt(chosen)
      if (db) return session(db)
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
    const resolved = await this.resolve(key)
    if (!resolved) throw new SQLiteError(`No snapshot "${key}"`, SQLITE_CANTOPEN)
    const {base, release} = resolved
    const db = openOn(Database, base.file(), base.size, `Snapshot "${key}"`, release)
    db.base = base
    return db
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
    const lock = once(await this.hold(key))
    let release = lock
    let registered = false
    try {
      const content = newSnapshot(snapshot, key, branch, meta, this.maxDepth)
      // Without locks, retain() elsewhere may have deleted the snapshot a
      // delta would lie over: then write in full.
      if (content.delta && !this.locks) {
        const parent = await this.store.get(content.delta.parent).catch(() => undefined)
        if (!parent || parent.info.size === 0) content.delta = undefined
      }
      const written = await this.exclusive(key, () => this.store.write(content))
      let target: Base
      if (written) {
        const from = snapshot.base as Base | undefined
        const {chunkSize, visible, pages, delta} = content
        const layout = delta && {...delta, chunkSize, visible, pages}
        // Only for its time: the fallback is close enough if reading fails.
        const stored = await this.store.get(key).catch(() => undefined)
        const info: SnapshotInfo = stored?.info ?? {
          key,
          branch,
          meta,
          createdAt: now(),
          size: content.size,
          ...(delta && {parent: delta.parent})
        }
        target = baseOf({info, source: written, delta: layout, below: layout && from?.layer})
        if (layout && from) {
          // The new snapshot needs the ones it lies over.
          const below = await this.holdAll(from.keys)
          release = once(() => {
            lock()
            below()
          })
        }
      } else {
        const found = await this.existing(snapshot, key)
        if (found.status !== 'move') {
          lock()
          return {status: found.status, snapshot: found.info} as SaveResult
        }
        target = found.base
        // Resolving it holds the key too.
        lock()
        release = found.release
      }
      const from = snapshot.base
      const files = filesOf(db.wasm)
      const file = `snapshots/${nextFile++}/${key}`
      // From here on, the locks are released once nothing reads the file.
      files.add(file, target.file(), release)
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
    | {status: 'move'; base: Base; release: () => void; info?: undefined}
    | {status: 'joined' | 'mismatch'; info: SnapshotInfo | undefined}
  > {
    const current = snapshot.base as Base | undefined
    let release = () => {}
    try {
      // A key names content, but other Workers may have stored the same
      // rows in other pages, under which the pages a database holds would
      // not fit.
      const content = newSnapshot(snapshot, key, '', {}, 0)
      if (current?.key === key) {
        const unchanged =
          content.pages.length === 0 && content.size === current.size
        return {status: unchanged ? 'joined' : 'mismatch', info: infoOf(current)}
      }
      const found = await this.resolve(key)
      if (!found) return {status: 'mismatch', info: undefined}
      release = found.release
      const same = sameDelta(found.base.layer, current, content)
      const equal =
        same === undefined ? await holds(found.base.content(), content) : await same
      if (!equal) {
        release()
        return {status: 'mismatch', info: infoOf(found.base)}
      }
      return {status: 'move', base: found.base, release}
    } catch {
      // Deleted while it was read: the database stays where it is.
      release()
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
    const keys = new Set<string>()
    for (const snapshot of all) {
      if (pinned.has(snapshot.key)) {
        keys.add(snapshot.key)
      } else if (snapshot.size > 0) {
        const count = (seen.get(snapshot.branch) ?? 0) + 1
        seen.set(snapshot.branch, count)
        if (count <= keep && kept.has(snapshot.branch)) keys.add(snapshot.key)
      } else if (!this.locks && now() - snapshot.createdAt < STALE_MS) {
        // Empty snapshots are being written, which locks them, or writing
        // them failed. Without locks, only the ones that are old have failed.
        keys.add(snapshot.key)
      }
    }
    // And the snapshots that those lie over
    const parents = new Map(all.map(s => [s.key, s.parent]))
    for (const key of [...keys]) {
      for (let at = parents.get(key); at !== undefined && !keys.has(at); at = parents.get(at))
        keys.add(at)
    }
    const deleted: Array<string> = []
    for (const snapshot of all) {
      if (keys.has(snapshot.key)) continue
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

  /** The branch saves go to */
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

/**
 * What saving `snapshot` writes: its pages over the snapshot it reads, as
 * a delta while the deltas below it are few and small (see MAX_DEPTH),
 * else in full.
 */
function newSnapshot(
  snapshot: Database,
  key: string,
  branch: string,
  meta: SnapshotMeta,
  maxDepth: number
): NewSnapshot {
  const {chunkSize, size, visible, pages: all} = snapshot.pages()
  const base = snapshot.base as Base | undefined
  if (visible > 0 && !base)
    throw new SQLiteError(
      'Database reads a snapshot it was not opened on',
      SQLITE_MISUSE
    )
  // Pages past the end were truncated away.
  const pages = all.filter(([index]) => index * chunkSize < size)
  let delta: NewSnapshot['delta']
  if (base && visible > 0) {
    const bytes = pages.length * chunkSize
    const depth = base.depth + 1
    const chainBytes = base.chainBytes + bytes
    if (depth <= maxDepth && bytes * 2 <= size && chainBytes <= size)
      delta = {parent: base.key, depth, chainBytes}
  }
  // Composed once, when a store reads it, and only for this save
  let content: BaseSource | undefined
  // The snapshot is not used meanwhile, so its pages stay where they are,
  // but the Wasm heap may grow: take HEAPU8 afresh.
  return {
    key,
    branch,
    meta,
    get base() {
      return (content ??= base?.content())
    },
    visible,
    size,
    chunkSize,
    pages: pages.map(([index]) => index),
    page(i) {
      const pointer = pages[i][1]
      return snapshot.wasm.HEAPU8.subarray(pointer, pointer + chunkSize)
    },
    delta
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
