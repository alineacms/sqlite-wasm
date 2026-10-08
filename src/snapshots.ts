import type {Database} from './Database.js'
import {filesOf, type SyncFile} from './opfs.js'
import {SQLiteError} from './SQLiteError.js'

// Databases on immutable base files: every Worker opens a copy-on-write
// overlay over a base file, which SQLite reads pages from as it needs them
// (through the "js" VFS, jsvfs.c), and keeps every change in memory. Base
// files are never written once they exist, so any number of Workers, also
// of different builds, can read them at the same time. A checkpoint writes
// a new base file: a copy of the current one with the pages the database
// holds written over it, after which the database reads that one instead
// and drops those pages (see "Read-only base files of another VFS" in
// overlay.c).
//
// Locks (Web Locks API), per base file:
//   read   shared while a database or fork reads it, or a checkpoint writes
//          it; cleanup only deletes files it can lock exclusively
//   write  exclusive while a checkpoint writes it, so one Worker writes a
//          name and the others find it written

const SQLITE_BUSY = 5
const SQLITE_READONLY = 8
const SQLITE_IOERR_READ = 266
const SQLITE_CORRUPT = 11
const SQLITE_CANTOPEN = 14
const SQLITE_MISUSE = 21
// Pages written to a new base file at once
const WRITE_BYTES = 4 << 20
// Page cache of databases on a base file, in KiB (PRAGMA cache_size): pages
// are read from the file again once they leave it, which takes about a
// millisecond for 64 KB.
const CACHE_KIB = 8192

/** A file's content that does not change: a `File` from OPFS, or bytes. */
export type BaseSource = Blob | Uint8Array

/**
 * A read-only `SyncFile` over `source`. Blobs, such as the `File` of an
 * OPFS file, are read synchronously with `FileReaderSync`, which Workers
 * have (not the main thread); a `File` keeps the content it had when it
 * was got, while the file stays the same.
 */
export function readOnlyFile(source: BaseSource): SyncFile {
  const readOnly = () => {
    throw new SQLiteError('Base files are read-only', SQLITE_READONLY)
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

function slice(source: BaseSource, end: number): BaseSource {
  return source instanceof Uint8Array
    ? source.subarray(0, end)
    : source.slice(0, end)
}

/** A file in a `SnapshotDirectory`. */
export interface BaseFile {
  name: string
  size: number
  lastModified: number
}

/** Writes a new base file, which appears in full when it closes. */
export interface BaseWriter {
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

/** Where a `SnapshotStorage` keeps its base files, such as OPFS. */
export interface SnapshotDirectory {
  /** If it works in this context */
  supported(): boolean
  list(): Promise<Array<BaseFile>>
  /** The content of file `name`, which stays as it is, if it exists. */
  get(name: string): Promise<BaseSource | undefined>
  create(name: string): Promise<BaseWriter>
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
      const files: Array<BaseFile> = []
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

export interface SnapshotStorageOptions {
  /** Web Locks implementation (default: `navigator.locks`); `null` for none */
  locks?: Pick<LockManager, 'request'> | null
}

/**
 * Keeps databases in immutable base files in the directory called `name`
 * of the origin private file system (OPFS), or of `options.directory`.
 * Any number of Workers, dedicated or shared, open a database on the same
 * base at once; SQLite reads its pages as it needs them, and keeps every
 * change in the Worker's memory. `checkpoint` writes those changes to a new
 * base file.
 *
 * ```ts
 * import {init} from '@alinea/sqlite-wasm'
 * import {snapshotStorage} from '@alinea/sqlite-wasm/snapshots'
 *
 * const {Database} = await init()
 * const storage = snapshotStorage('entries')
 * const db = await storage.open(Database)
 * db.run('create table if not exists notes (text)')
 * await storage.checkpoint(db, 'v2')
 * await storage.cleanup()
 * ```
 */
export function snapshotStorage(
  name: string,
  options?: SnapshotStorageOptions & {directory?: FileSystemDirectoryHandle}
): SnapshotStorage {
  return new SnapshotStorage(
    name,
    opfsSnapshotDirectory(name, options?.directory),
    options
  )
}

/** The base file a database reads, kept as `db.base`. */
interface Base {
  name: string
  source: BaseSource
}

/** Names of the "js" VFS files base files are registered as */
let nextKey = 0

/**
 * Checkpoints of each database, which run one after the other, and the
 * snapshots they write
 */
const checkpoints = new WeakMap<
  Database,
  {queue: Promise<unknown>; snapshots: Set<Database>}
>()

function checkHeader(header: Uint8Array, size: number, name: string) {
  const corrupt = (reason: string) =>
    new SQLiteError(`Base "${name}" is corrupt: ${reason}`, SQLITE_CORRUPT)
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

async function readHeader(source: BaseSource) {
  const head = slice(source, 100)
  return head instanceof Uint8Array
    ? head
    : new Uint8Array(await head.arrayBuffer())
}

export class SnapshotStorage {
  private locks: Pick<LockManager, 'request'> | null

  /**
   * Keep base files in `directory`. Storages with the same `name` share
   * their locks, so give storages of different directories different names.
   */
  constructor(
    public readonly name: string,
    public readonly directory: SnapshotDirectory,
    options?: SnapshotStorageOptions
  ) {
    this.locks =
      options?.locks !== undefined
        ? options.locks
        : (globalThis.navigator?.locks ?? null)
  }

  /** If base files can be read and written in this context. */
  supported(): boolean {
    return this.directory.supported()
  }

  private lockName(kind: 'read' | 'write', base: string) {
    return JSON.stringify(['@alinea/sqlite-wasm/snapshots', this.name, kind, base])
  }

  /**
   * Hold a shared lock on reading base file `name`, which keeps cleanup
   * from deleting it, until the returned function is called.
   */
  private hold(name: string): Promise<() => void> {
    const locks = this.locks
    if (!locks) return Promise.resolve(() => {})
    return new Promise((resolve, reject) => {
      locks
        .request(this.lockName('read', name), {mode: 'shared'}, () =>
          new Promise<void>(release => resolve(release))
        )
        .catch(reject)
    })
  }

  /** The base file modified last, if there is one. */
  async newest(): Promise<string | undefined> {
    let newest: BaseFile | undefined
    for (const file of await this.directory.list()) {
      // Empty files are being written, or were left by a failed write.
      if (file.size === 0) continue
      if (!newest || file.lastModified > newest.lastModified) newest = file
    }
    return newest?.name
  }

  /**
   * Open a database on base file `name`, or on the newest base file. Pages
   * are read from the file as queries need them, and every change is kept
   * in memory: `checkpoint` writes them to a new base file, and they are
   * lost when the database closes or the Worker ends. SQLite keeps up to
   * 8 MB of the pages it read in its page cache (`PRAGMA cache_size`, also
   * for forks). Without base files, the database starts empty. Rejects with `SQLITE_CANTOPEN` if base file
   * `name` does not exist, and with `SQLITE_CORRUPT` if it is not a
   * database.
   */
  async open<T extends Database>(
    Database: new () => T,
    name?: string
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const base = name ?? (await this.newest())
      if (base === undefined) return new Database()
      try {
        return await this.openBase(Database, base)
      } catch (error) {
        // The newest file was deleted after it was listed: a newer one
        // replaced it.
        const missing = (error as SQLiteError)?.resultCode === SQLITE_CANTOPEN
        if (name !== undefined || !missing || attempt >= 2) throw error
      }
    }
  }

  private async openBase<T extends Database>(
    Database: new () => T,
    name: string
  ): Promise<T> {
    const release = once(await this.hold(name))
    let db: T | undefined
    try {
      const source = await this.directory.get(name)
      if (!source || sizeOf(source) === 0)
        throw new SQLiteError(`No base file "${name}"`, SQLITE_CANTOPEN)
      checkHeader(await readHeader(source), sizeOf(source), name)
      db = new Database()
      const opened = db
      this.use(opened, {name, source}, release, key => opened.openBase(key))
      try {
        db.exec('select count(*) from sqlite_schema')
        db.run(`pragma cache_size = -${CACHE_KIB}`)
      } catch (error) {
        throw new SQLiteError(
          `Base "${name}" is corrupt: ${(error as Error).message}`,
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
   * Have `db` read `base` with `open(key)`, and call `release` once no
   * database or fork reads it anymore.
   */
  private use(
    db: Database,
    base: Base,
    release: () => void,
    open: (key: string) => void
  ) {
    const files = filesOf(db.wasm)
    const key = `snapshots/${nextKey++}/${base.name}`
    files.add(key, readOnlyFile(base.source), release)
    try {
      open(key)
      db.base = base
    } finally {
      // Opening failed before SQLite opened the file.
      if (files.openHandles(key) === 0) files.remove(key)
    }
  }

  /**
   * Write the committed state of `db` to a new base file called `name`,
   * and have `db` read that from now on: the pages it holds that did not
   * change since are dropped from memory. The database keeps working
   * meanwhile; changes made after the checkpoint started stay in memory.
   * Resolves to `false`, without changing `db`, if base file `name` exists
   * already: name base files by their content, so a name always means the
   * same data. The state is taken when `checkpoint` is called; checkpoints
   * of one database are written one at a time. Fails with
   * `SQLITE_BUSY` during a write transaction and `SQLITE_MISUSE` for a
   * database stored elsewhere, such as in IndexedDB.
   */
  checkpoint(db: Database, name: string): Promise<boolean> {
    let snapshot: Database
    try {
      if (db.file !== undefined || db.persistence)
        throw new SQLiteError('Database is stored elsewhere', SQLITE_MISUSE)
      try {
        snapshot = db.fork()
      } catch (error) {
        throw new SQLiteError((error as Error).message, SQLITE_BUSY, {
          cause: error
        })
      }
    } catch (error) {
      return Promise.reject(error)
    }
    let state = checkpoints.get(db)
    if (!state) checkpoints.set(db, (state = {queue: Promise.resolve(), snapshots: new Set()}))
    const {snapshots} = state
    snapshots.add(snapshot)
    const next = state.queue
      .catch(() => {})
      .then(() => this.write(db, snapshot, snapshots, name))
      .finally(() => {
        snapshots.delete(snapshot)
        snapshot.close()
      })
    state.queue = next
    return next
  }

  /**
   * Write base file `name` from `snapshot`, and move `db` onto it, with the
   * later snapshots of `db` that wait for their turn: they read the same
   * base file as `db` until then.
   */
  private async write(
    db: Database,
    snapshot: Database,
    snapshots: Set<Database>,
    name: string
  ): Promise<boolean> {
    const release = once(await this.hold(name))
    try {
      const written = await this.exclusive(name, () =>
        this.writeBase(snapshot, name)
      )
      if (!written) {
        release()
        return false
      }
      const source = await this.directory.get(name)
      if (!source)
        throw new SQLiteError(`No base file "${name}"`, SQLITE_CANTOPEN)
      const base = {name, source}
      this.use(db, base, release, key => {
        db.rebase(snapshot, key)
        for (const later of snapshots) {
          if (later === snapshot) continue
          later.rebase(snapshot, key)
          later.base = base
        }
      })
      return true
    } catch (error) {
      release()
      throw error
    }
  }

  private exclusive<T>(name: string, write: () => Promise<T>): Promise<T> {
    if (!this.locks) return write()
    return this.locks.request(this.lockName('write', name), write)
  }

  /** Write base file `name` with the content of `snapshot`, if it is new. */
  private async writeBase(snapshot: Database, name: string): Promise<boolean> {
    const existing = await this.directory.get(name)
    if (existing && sizeOf(existing) > 0) return false
    const {chunkSize, size, visible, pages} = snapshot.pages()
    const base = snapshot.base as Base | undefined
    if (visible > 0 && !base)
      throw new SQLiteError('Database reads a base file it was not opened on', SQLITE_MISUSE)
    const writer = await this.directory.create(name)
    try {
      if (base && visible > 0) {
        if (sizeOf(base.source) < visible)
          throw new SQLiteError(`Base "${base.name}" is too short`, SQLITE_IOERR_READ)
        await writer.copy(slice(base.source, visible))
      }
      await writer.truncate(visible)
      // Write runs of consecutive pages at once. The snapshot is not used
      // meanwhile, so its pages stay where they are, but the Wasm heap may
      // grow: take HEAPU8 afresh.
      const perWrite = Math.max(1, Math.floor(WRITE_BYTES / chunkSize))
      for (let i = 0; i < pages.length; ) {
        let end = i + 1
        while (
          end < pages.length &&
          end - i < perWrite &&
          pages[end][0] === pages[end - 1][0] + 1
        )
          end++
        const run = new Uint8Array((end - i) * chunkSize)
        for (let k = i; k < end; k++) {
          const pointer = pages[k][1]
          run.set(
            snapshot.wasm.HEAPU8.subarray(pointer, pointer + chunkSize),
            (k - i) * chunkSize
          )
        }
        await writer.write(run, pages[i][0] * chunkSize)
        i = end
      }
      await writer.truncate(size)
      await writer.close()
      return true
    } catch (error) {
      await writer.abort().catch(() => {})
      throw error
    }
  }

  /**
   * Delete the base files no database reads, except the newest. Without Web
   * Locks, which tell what other Workers read, it keeps the newest two.
   * Resolves to the names of the deleted files.
   */
  async cleanup(): Promise<Array<string>> {
    const files = (await this.directory.list()).sort(
      (a, b) => b.lastModified - a.lastModified
    )
    const newest = await this.newest()
    const deleted: Array<string> = []
    const locks = this.locks
    if (!locks) {
      for (const file of files.slice(2)) {
        await this.directory.remove(file.name)
        deleted.push(file.name)
      }
      return deleted
    }
    for (const file of files) {
      if (file.name === newest) continue
      await locks.request(
        this.lockName('read', file.name),
        {mode: 'exclusive', ifAvailable: true},
        async lock => {
          if (!lock) return
          await this.directory.remove(file.name)
          deleted.push(file.name)
        }
      )
    }
    return deleted
  }
}

function once(action: () => void) {
  let done = false
  return () => {
    if (done) return
    done = true
    action()
  }
}
