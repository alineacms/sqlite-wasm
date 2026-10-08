import type {Database, Persistence, Storage} from './Database.js'
import type {JSFiles, SQLite3Wasm} from './sqlite3-emscripten.js'
import {SQLiteError} from './SQLiteError.js'

// A database stored this way is not kept in memory: SQLite reads its pages
// from the file as it needs them (through the "js" VFS, jsvfs.c), and every
// commit is stored before it returns, in a redo journal next to the file
// (see "Writable base files" in overlay.c).

const SQLITE_BUSY = 5
const SQLITE_IOERR_READ = 266
const SQLITE_IOERR_SHORT_READ = 522
const SQLITE_IOERR_WRITE = 778
const SQLITE_IOERR_FSYNC = 1034
const SQLITE_IOERR_TRUNCATE = 1546

/**
 * A file opened for synchronous reads and writes, such as OPFS's
 * `FileSystemSyncAccessHandle`.
 */
export interface SyncFile {
  read(buffer: Uint8Array, options: {at: number}): number
  write(buffer: Uint8Array, options: {at: number}): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

/** Where `fileStorage` keeps its files. */
export interface FileSystem {
  /** Open the file called `name` for synchronous access, creating it. */
  open(name: string): Promise<SyncFile>
  /** Delete the file called `name`, if it exists. */
  remove(name: string): Promise<void>
}

/**
 * The origin private file system, or a directory of it. Its files can only
 * be opened for synchronous access in a dedicated Worker, by one Worker at
 * a time: opening a file another one holds fails with `SQLITE_BUSY`.
 */
export function opfsFileSystem(
  directory?: FileSystemDirectoryHandle
): FileSystem {
  const dir = () =>
    directory ? Promise.resolve(directory) : navigator.storage.getDirectory()
  return {
    async open(name) {
      const handle = await (await dir()).getFileHandle(name, {create: true})
      try {
        return await handle.createSyncAccessHandle()
      } catch (error) {
        // Chromium and Firefox: NoModificationAllowedError, WebKit:
        // InvalidStateError
        const kind = (error as DOMException)?.name
        if (kind === 'NoModificationAllowedError' || kind === 'InvalidStateError') {
          throw new SQLiteError(
            `OPFS file "${name}" is open in another Worker`,
            SQLITE_BUSY,
            {cause: error}
          )
        }
        throw error
      }
    },
    async remove(name) {
      try {
        await (await dir()).removeEntry(name)
      } catch (error) {
        if ((error as DOMException)?.name !== 'NotFoundError') throw error
      }
    }
  }
}

/**
 * Answers the "js" VFS of one Wasm module with the files storages opened.
 * @internal
 */
export class Files implements JSFiles {
  private ids = new Map<string, number>()
  private files: Array<SyncFile | undefined> = []
  /** Handles SQLite has open, for files added with a release callback */
  private handles = new Map<
    number,
    {name: string; count: number; release: () => void}
  >()

  constructor(private wasm: SQLite3Wasm) {}

  /**
   * Make `file` available as `name`. With `release`, the file is removed,
   * and `release` called, once SQLite closes the last handle it opened.
   */
  add(name: string, file: SyncFile, release?: () => void) {
    const id = this.files.length
    this.ids.set(name, id)
    this.files.push(file)
    if (release) this.handles.set(id, {name, count: 0, release})
  }

  /** Handles SQLite has open on `name` (for files added with `release`) */
  openHandles(name: string) {
    const id = this.ids.get(name)
    return id === undefined ? 0 : (this.handles.get(id)?.count ?? 0)
  }

  remove(name: string) {
    const id = this.ids.get(name)
    if (id === undefined) return
    this.ids.delete(name)
    this.files[id] = undefined
    const handles = this.handles.get(id)
    if (!handles) return
    this.handles.delete(id)
    handles.release()
  }

  // Calls from Wasm must not throw: errors become SQLite result codes.
  private use(id: number, error: number, action: (file: SyncFile) => number) {
    const file = this.files[id]
    if (!file) return error
    try {
      return action(file)
    } catch {
      return error
    }
  }

  open(name: string) {
    const id = this.ids.get(name)
    if (id === undefined) return -1
    const handles = this.handles.get(id)
    if (handles) handles.count++
    return id
  }

  close(id: number) {
    const handles = this.handles.get(id)
    if (handles && --handles.count === 0) this.remove(handles.name)
    return 0
  }

  read(id: number, ptr: number, size: number, offset: number) {
    return this.use(id, SQLITE_IOERR_READ, file => {
      const target = this.wasm.HEAPU8.subarray(ptr, ptr + size)
      const read = file.read(target, {at: offset})
      if (read >= size) return 0
      target.fill(0, read)
      return SQLITE_IOERR_SHORT_READ
    })
  }

  write(id: number, ptr: number, size: number, offset: number) {
    return this.use(id, SQLITE_IOERR_WRITE, file => {
      const source = this.wasm.HEAPU8.subarray(ptr, ptr + size)
      return file.write(source, {at: offset}) === size ? 0 : SQLITE_IOERR_WRITE
    })
  }

  truncate(id: number, size: number) {
    return this.use(id, SQLITE_IOERR_TRUNCATE, file => {
      file.truncate(size)
      return 0
    })
  }

  sync(id: number) {
    return this.use(id, SQLITE_IOERR_FSYNC, file => {
      file.flush()
      return 0
    })
  }

  size(id: number) {
    return this.use(id, -1, file => file.getSize())
  }

  delete() {
    return 0
  }

  exists(name: string) {
    const id = this.ids.get(name)
    return id !== undefined && this.size(id) > 0 ? 1 : 0
  }
}

/** @internal */
export function filesOf(wasm: SQLite3Wasm): Files {
  if (!(wasm.jsvfs instanceof Files)) wasm.jsvfs = new Files(wasm)
  return wasm.jsvfs as Files
}

/** Names in use in one file system, in this realm. */
const active = new WeakMap<FileSystem, Set<string>>()

function activeIn(fileSystem: FileSystem) {
  let names = active.get(fileSystem)
  if (!names) active.set(fileSystem, (names = new Set()))
  return names
}

/**
 * The name of a file in the "js" VFS, which is shared by every file
 * system: the file's name, prefixed with an id for its file system.
 */
const ids = new WeakMap<FileSystem, number>()
let nextId = 0

function fileKey(fileSystem: FileSystem, name: string) {
  let id = ids.get(fileSystem)
  if (id === undefined) ids.set(fileSystem, (id = nextId++))
  return `${id}/${name}`
}

function busy(name: string) {
  return new SQLiteError(
    `File "${name}" stores another database; close it first`,
    SQLITE_BUSY
  )
}

class FilePersistence implements Persistence {
  private closed = false
  private error?: SQLiteError

  constructor(
    private db: Database,
    private release: () => void
  ) {}

  // Commits are stored before they return; this retries any that failed,
  // or after closing or detaching, reports if storing the last ones failed.
  async flush() {
    if (!this.closed) this.db.storeFile()
    else if (this.error) throw this.error
  }

  detach() {
    if (this.closed) return
    // Throws, staying attached, if the database cannot be read into memory.
    this.error = this.db.detachFile()
    this.close()
  }

  // A last try at storing commits that failed, which flush() reports.
  closing() {
    if (this.closed) return
    try {
      this.db.storeFile()
    } catch (error) {
      this.error = error as SQLiteError
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.release()
  }
}

let defaultFileSystem: FileSystem | undefined

/**
 * Keeps a database in the file called `name` of the origin private file
 * system (OPFS), or of `options.directory`. Pass it to `Database.sync` in a
 * dedicated Worker:
 *
 * ```ts
 * import {init} from '@alinea/sqlite-wasm'
 * import {opfsStorage} from '@alinea/sqlite-wasm/opfs'
 *
 * const {Database} = await init()
 * const db = await Database.sync(opfsStorage('notes.sqlite3'))
 * db.run('create table if not exists notes (text)')
 * ```
 *
 * Unlike IndexedDB storage, the database is not loaded into memory: pages
 * are read from the file as queries need them, and only the pages of the
 * open transaction are held in memory. Every commit is stored when it
 * returns, in a redo journal next to the file (`name` plus `-journal`) that
 * is replayed after a crash.
 *
 * OPFS files can only be opened this way in a dedicated Worker, by one
 * Worker at a time: syncing a database another Worker or tab holds fails
 * with `SQLITE_BUSY`. Have one Worker own the database and the others send
 * it their queries. `db.fork()` creates an in-memory snapshot, which keeps
 * its content when the stored database changes or closes.
 *
 * `db.attach` stores a database that is in memory in the file instead,
 * replacing what it held, and `db.detach` moves a stored database back
 * into memory.
 */
export function opfsStorage(
  name: string,
  options?: {directory?: FileSystemDirectoryHandle}
): FileStorage {
  const fileSystem = options?.directory
    ? opfsFileSystem(options.directory)
    : (defaultFileSystem ??= opfsFileSystem())
  return new FileStorage(name, fileSystem)
}

/**
 * Keeps a database in the file called `name` of any `FileSystem` that
 * opens files for synchronous access. See `opfsStorage`.
 */
export function fileStorage(name: string, fileSystem: FileSystem) {
  return new FileStorage(name, fileSystem)
}

export class FileStorage implements Storage {
  constructor(
    public readonly name: string,
    private readonly fileSystem: FileSystem
  ) {}

  private get journal() {
    return `${this.name}-journal`
  }

  sync<T extends Database>(
    Database: new (data?: ArrayBufferView) => T
  ): Promise<T> {
    return this.store(() => new Database(), (db, key) => db.openFile(key), true)
  }

  /**
   * Store a database that is in memory from now on: its committed state
   * replaces what the file held, written as one commit, after which it is
   * no longer kept in memory. See `opfsStorage`.
   */
  async attach(db: Database): Promise<void> {
    await this.store(() => db, (db, key) => db.attachFile(key), false)
  }

  /**
   * Open the files, have the database create() returns use them, with
   * use(), and keep them until it closes or detaches.
   */
  private async store<T extends Database>(
    create: () => T,
    use: (db: T, key: string) => void,
    owned: boolean
  ): Promise<T> {
    const names = activeIn(this.fileSystem)
    if (names.has(this.name)) throw busy(this.name)
    names.add(this.name)
    const key = fileKey(this.fileSystem, this.name)
    // The overlay names its journal after the file (see overlay.c).
    const keys = [key, `${key}-journal`]
    const opened: Array<SyncFile> = []
    let db: T | undefined
    let files: Files | undefined
    const release = () => {
      opened.forEach((file, i) => {
        files?.remove(keys[i])
        file.close()
      })
      names.delete(this.name)
    }
    try {
      for (const name of [this.name, this.journal]) {
        opened.push(await this.fileSystem.open(name))
      }
      db = create()
      files = filesOf(db.wasm)
      opened.forEach((file, i) => files!.add(keys[i], file))
      use(db, key)
      db.persistence = new FilePersistence(db, release)
      return db
    } catch (error) {
      try {
        if (owned) db?.close()
      } finally {
        release()
      }
      throw error
    }
  }

  /**
   * Delete the stored database and its journal. Fails with `SQLITE_BUSY`
   * while a database is stored under this name.
   */
  async delete(): Promise<void> {
    if (activeIn(this.fileSystem).has(this.name)) throw busy(this.name)
    await this.fileSystem.remove(this.name)
    await this.fileSystem.remove(this.journal)
  }
}
