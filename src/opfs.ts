import type {Database, Persistence, Storage} from './Database.js'
import type {JSFiles, SQLite3Wasm} from './sqlite3-emscripten.js'
import {SQLiteError} from './SQLiteError.js'

// A database stored this way is not kept in memory: SQLite reads its pages
// from the file as it needs them (through the "js" VFS, jsvfs.c), and every
// commit is written to the file before it returns, through a redo journal
// next to it (see "Writable base files" in overlay.c).

const SQLITE_BUSY = 5
const SQLITE_MISUSE = 21
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
        if ((error as DOMException)?.name === 'NoModificationAllowedError') {
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

/** Answers the "js" VFS of one Wasm module with the files storages opened. */
class Files implements JSFiles {
  private ids = new Map<string, number>()
  private files: Array<SyncFile | undefined> = []

  constructor(private wasm: SQLite3Wasm) {}

  add(name: string, file: SyncFile) {
    this.ids.set(name, this.files.length)
    this.files.push(file)
  }

  remove(name: string) {
    const id = this.ids.get(name)
    if (id === undefined) return
    this.ids.delete(name)
    this.files[id] = undefined
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
    return this.ids.get(name) ?? -1
  }

  close() {
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

function filesOf(wasm: SQLite3Wasm): Files {
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

function busy(name: string) {
  return new SQLiteError(
    `File "${name}" stores another database; close it first`,
    SQLITE_BUSY
  )
}

class FilePersistence implements Persistence {
  private closed = false

  constructor(
    private db: Database,
    private release: () => void
  ) {}

  // Commits are stored before they return; this retries any that failed.
  async flush() {
    if (!this.closed) this.db.storeFile()
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
 * open transaction are held in memory. Every commit is in the file when it
 * returns, written through a redo journal (`name` plus `-journal`), so the
 * file always holds a committed state.
 *
 * OPFS files can only be opened this way in a dedicated Worker, by one
 * Worker at a time: syncing a database another Worker or tab holds fails
 * with `SQLITE_BUSY`. Have one Worker own the database and the others send
 * it their queries. `db.fork()` creates an in-memory snapshot, which keeps
 * its content when the stored database changes or closes.
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

  async sync<T extends Database>(
    Database: new (data?: ArrayBufferView) => T
  ): Promise<T> {
    const names = activeIn(this.fileSystem)
    if (names.has(this.name)) throw busy(this.name)
    names.add(this.name)
    const opened: Array<[string, SyncFile]> = []
    let db: T | undefined
    let files: Files | undefined
    const release = () => {
      for (const [name, file] of opened) {
        files?.remove(name)
        file.close()
      }
      names.delete(this.name)
    }
    try {
      for (const name of [this.name, this.journal]) {
        opened.push([name, await this.fileSystem.open(name)])
      }
      db = new Database()
      files = filesOf(db.wasm)
      for (const [name, file] of opened) files.add(name, file)
      db.openFile(this.name)
      db.persistence = new FilePersistence(db, release)
      return db
    } catch (error) {
      try {
        db?.close()
      } finally {
        release()
      }
      throw error
    }
  }

  /**
   * Not supported: a database in memory cannot move into a file. Store
   * `db.export()` with `sync` on a new database instead.
   */
  async attach(_db: Database): Promise<void> {
    throw new SQLiteError(
      'A database in memory cannot be attached to file storage',
      SQLITE_MISUSE
    )
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
