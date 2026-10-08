import type {
  BindParams,
  ParamsCallback,
  QueryExecResult,
  StatementIterator
} from 'sql.js'
import type {SQLite3Wasm} from './sqlite3-emscripten'
import {SQLiteError} from './SQLiteError.js'
import {Pointer, QueryResult, ReturnCode, ReturnMap} from './sqlite3-types.js'
import {Statement} from './Statement.js'

const LOAD_CHUNK_SIZE = 1 << 20
const TXN_WRITE = 2 // SQLITE_TXN_WRITE

/**
 * The parts of the database file one commit changed, in chunks of
 * `chunkSize` bytes. Chunks at or past `minSize` that are not in `chunks`
 * were truncated away and read as zero.
 * @internal
 */
export interface Commit {
  chunkSize: number
  /** File size after the commit */
  size: number
  /** Smallest file size during the commit */
  minSize: number
  /** Content of every written chunk, by chunk index */
  chunks: Map<number, Uint8Array>
}

/**
 * The pages a database holds over its base file, in chunks of `chunkSize`
 * bytes: `[index, pointer]` per chunk, pointing into the Wasm heap, valid
 * until the database changes or closes. Chunks it does not hold read from
 * the base file below `visible`, and as zero from there to `size`.
 * @internal
 */
export interface Pages {
  chunkSize: number
  size: number
  visible: number
  pages: Array<[index: number, pointer: Pointer]>
}

/** Storage that commits are written to, such as IndexedDB. @internal */
export interface Persistence {
  flush(): Promise<void>
  close(): void
  /** Stop storing, for storage that does not use the commit listener */
  detach?(): void
  /** Called right before the database closes */
  closing?(): void
}

/**
 * A place to keep a database, such as `indexedDBStorage(name)` from
 * `@alinea/sqlite-wasm/indexeddb`. See `Database.sync` and `db.attach`.
 */
export interface Storage {
  sync<T extends Database>(
    Database: new (data?: ArrayBufferView) => T
  ): Promise<T>
  attach(db: Database): Promise<void>
}

export class Database {
  /** @internal */ public statements!: Record<number, Statement>
  /** @internal */ public wasm!: SQLite3Wasm
  /** @internal */ private dbPtr!: Pointer
  /** @internal */ private functions!: Record<string, Pointer>
  /** @internal */ private commitListener?: Pointer
  /** @internal */ private commitWatch?: {
    pointer: Pointer
    listeners: Set<() => void>
  }
  /** @internal */ public persistence?: Persistence
  /** The file of the "js" VFS this database is stored in @internal */
  public file?: string
  /** The base file a snapshot storage opened this database on @internal */
  public base?: unknown
  /** @internal */ private attaching = false

  /**
   * Represents an SQLite database
   * @see [https://sql.js.org/documentation/Database.html#Database](https://sql.js.org/documentation/Database.html#Database)
   *
   * @param data An array of bytes representing an SQLite database file
   */
  constructor(wasm: SQLite3Wasm, data?: ArrayBufferView) {
    this.open(wasm, wasm.alinea_open(wasm.tempInt32))
    if (typeof data !== 'undefined' && data.byteLength > 0) {
      this.load(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
    // [TODO] Look into RegisterExtensionFunctions(this.db);
  }

  /**
   * Load the database kept in storage into memory, or start an empty one,
   * and keep storing every commit there. Queries run in memory as usual.
   * Await `flush()` to know the commits so far are stored.
   */
  static sync<T extends Database>(
    this: new (data?: ArrayBufferView) => T,
    storage: Storage
  ): Promise<T> {
    return storage.sync(this)
  }

  /**
   * Keep this database in storage from now on, as `Database.sync` does,
   * without loading anything: its committed state when storing starts
   * replaces whatever the storage held, as one write. Await `flush()` to
   * know it is written. Fails during a write transaction, and for a
   * database that is stored already; `detach()` it first.
   */
  async attach(storage: Storage): Promise<void> {
    if (!this.dbPtr) throw new Error('Database closed')
    if (this.attaching || this.commitListener || this.file !== undefined)
      throw new SQLiteError('Database is stored already', ReturnCode.MISUSE)
    this.attaching = true
    try {
      await storage.attach(this)
    } finally {
      this.attaching = false
    }
  }

  /**
   * Replace this new, empty database with the one stored in `file` of the
   * "js" VFS (see opfs.ts), or a new one there, which stores every commit.
   * @internal
   */
  openFile(file: string) {
    this.wasm.sqlite3_close_v2(this.dbPtr)
    this.open(
      this.wasm,
      this.wasm.alinea_open_file(encodeURIComponent(file), this.wasm.tempInt32)
    )
    this.file = file
  }

  /**
   * Replace this new, empty database with one that reads `file` of the "js"
   * VFS, a database file that does not change, and keeps every change in
   * memory (see snapshots.ts).
   * @internal
   */
  openBase(file: string) {
    this.wasm.sqlite3_close_v2(this.dbPtr)
    this.open(
      this.wasm,
      this.wasm.alinea_open_base(encodeURIComponent(file), this.wasm.tempInt32)
    )
  }

  /**
   * Call `listener` whenever a transaction commits, from inside the commit:
   * it must not use the database (schedule work instead). Returns a
   * function that stops calling it.
   * @internal
   */
  watchCommits(listener: () => void): () => void {
    if (!this.dbPtr) throw new Error('Database closed')
    if (!this.commitWatch) {
      const listeners = new Set<() => void>()
      const pointer = this.wasm.addFunction(() => {
        // An exception must not unwind through SQLite's commit.
        for (const listen of listeners) {
          try {
            listen()
          } catch {}
        }
        return 0
      }, 'ii')
      this.wasm.sqlite3_commit_hook(this.dbPtr, pointer, this.wasm.NULL)
      this.commitWatch = {pointer, listeners}
    }
    const {listeners} = this.commitWatch
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** If the database was closed. @internal */
  isClosed(): boolean {
    return !this.dbPtr
  }

  /** The pages this database holds over its base file. @internal */
  pages(): Pages {
    if (!this.dbPtr) throw new Error('Database closed')
    const wasm = this.wasm
    const stack = wasm.stackSave()
    try {
      const info = wasm.stackAlloc(16)
      const sizes = wasm.stackAlloc(16)
      const result = wasm.alinea_pages(this.dbPtr, info, sizes)
      if (result !== ReturnCode.OK)
        throw new SQLiteError(wasm.sqlite3_errstr(result), result)
      const count = wasm.getValue(info + 4, 'i32')
      const indexes = wasm.getValue(info + 8, '*')
      const pointers = wasm.getValue(info + 12, '*')
      const pages: Pages['pages'] = []
      for (let i = 0; i < count; i++) {
        // Chunk indexes are 64-bit, but fit the low 32 bits in Wasm.
        pages.push([
          wasm.getValue(indexes + 8 * i, 'i32'),
          wasm.getValue(pointers + 4 * i, '*')
        ])
      }
      wasm.sqlite3_free(indexes)
      return {
        chunkSize: wasm.getValue(info, 'i32'),
        size: wasm.getValue(sizes, 'double'),
        visible: wasm.getValue(sizes + 8, 'double'),
        pages
      }
    } finally {
      wasm.stackRestore(stack)
    }
  }

  /**
   * Read `file` of the "js" VFS from now on, which holds the committed
   * state of `snapshot`, a fork of this database on the same base file.
   * Pages that did not change since the fork are dropped from memory.
   * @internal
   */
  rebase(snapshot: Database, file: string) {
    if (!this.dbPtr || !snapshot.dbPtr) throw new Error('Database closed')
    const result = this.wasm.alinea_rebase(this.dbPtr, snapshot.dbPtr, file)
    if (result !== ReturnCode.OK)
      throw new SQLiteError(this.wasm.sqlite3_errstr(result), result)
  }

  /**
   * Store this database in `file` of the "js" VFS from now on, replacing
   * what it held, as if it had been opened with `openFile`.
   * @internal
   */
  attachFile(file: string) {
    if (!this.dbPtr) throw new Error('Database closed')
    const result = this.wasm.alinea_attach_file(this.dbPtr, file)
    if (result !== ReturnCode.OK) {
      throw new SQLiteError(this.wasm.sqlite3_errstr(result), result)
    }
    this.file = file
  }

  /**
   * Stop storing this database in its file and keep it in memory. Returns
   * the error of storing the last commits, if that failed.
   * @internal
   */
  detachFile(): SQLiteError | undefined {
    if (!this.dbPtr || this.file === undefined) return
    const result = this.wasm.alinea_detach_file(this.dbPtr, this.wasm.tempInt32)
    if (result !== ReturnCode.OK) {
      throw new SQLiteError(
        result === ReturnCode.BUSY
          ? 'Cannot detach a database during a write transaction'
          : this.wasm.sqlite3_errstr(result),
        result
      )
    }
    this.file = undefined
    const writeError = this.wasm.getValue(this.wasm.tempInt32, 'i32')
    return writeError === ReturnCode.OK
      ? undefined
      : new SQLiteError(this.wasm.sqlite3_errstr(writeError), writeError)
  }

  /** True while a transaction is open (after BEGIN). @internal */
  inTransaction(): boolean {
    return this.dbPtr !== this.wasm.NULL &&
      this.wasm.sqlite3_get_autocommit(this.dbPtr) === 0
  }

  /**
   * Store the commits of a database opened with `openFile` that could not
   * be stored yet, and throw if that fails again.
   * @internal
   */
  storeFile() {
    if (!this.dbPtr) return
    const result = this.wasm.alinea_flush(this.dbPtr)
    if (result !== ReturnCode.OK) {
      throw new SQLiteError(this.wasm.sqlite3_errstr(result), result)
    }
  }

  /** @internal */
  private open(wasm: SQLite3Wasm, openResult: ReturnCode) {
    this.wasm = wasm
    this.dbPtr = wasm.getValue(wasm.tempInt32, '*')
    this.statements = {}
    this.functions = {}
    if (openResult !== ReturnCode.OK) {
      this.fail(wasm.sqlite3_errmsg(this.dbPtr), openResult)
    }
  }

  /**
   * Copy (part of) a database image into the freshly opened database, a
   * piece at a time so the Wasm heap never holds the whole image twice.
   * Parts must be appended in order; `total` is the size of the image. The
   * image is stored in chunks of `chunkSize` bytes, or of its page size.
   * @internal
   */
  load(
    bytes: Uint8Array,
    offset = 0,
    total = bytes.byteLength,
    chunkSize = 0
  ) {
    const pieceSize = Math.min(bytes.byteLength, LOAD_CHUNK_SIZE)
    const piecePtr = this.wasm.alinea_malloc(pieceSize)
    if (piecePtr === this.wasm.NULL) {
      this.fail('Unable to allocate memory for the database')
    }
    try {
      for (let done = 0; done < bytes.byteLength; done += pieceSize) {
        const piece = bytes.subarray(done, done + pieceSize)
        this.wasm.HEAPU8.set(piece, piecePtr)
        const result = this.wasm.alinea_load(
          this.dbPtr,
          piecePtr,
          piece.byteLength,
          offset + done,
          total,
          chunkSize
        )
        if (result !== ReturnCode.OK) {
          this.fail(this.wasm.sqlite3_errstr(result), result)
        }
      }
    } finally {
      this.wasm.sqlite3_free(piecePtr)
    }
  }

  /** @internal */
  private fail(message: string, resultCode = ReturnCode.ERROR): never {
    this.wasm.sqlite3_close_v2(this.dbPtr)
    this.dbPtr = this.wasm.NULL
    throw new SQLiteError(message, resultCode)
  }

  /**
   * Create an independent copy of this database. The copy shares all pages
   * with this database and only copies a page when either side writes to it,
   * so forking is cheap regardless of the database size.
   *
   * The fork starts from the last committed state, and cannot be created
   * while this database has an open write transaction. Functions registered
   * with `create_function` are not carried over; `PRAGMA cache_size` is.
   */
  fork(): this {
    if (!this.dbPtr) {
      throw new Error('Database closed')
    }
    if (this.wasm.sqlite3_txn_state(this.dbPtr, 'main') === TXN_WRITE) {
      throw new Error('Cannot fork a database during a write transaction')
    }
    const openResult = this.wasm.alinea_fork(this.dbPtr, this.wasm.tempInt32)
    const fork: this = Object.create(Object.getPrototypeOf(this))
    fork.open(this.wasm, openResult)
    fork.base = this.base
    // Keep the page cache size of the source: pages of a base are read from
    // it again once they leave the cache.
    const [[cacheSize]] = this.exec('pragma cache_size')[0].values
    fork.run(`pragma cache_size = ${cacheSize}`)
    return fork
  }

  /**
   * Call listener after every commit with copies of the chunks it changed,
   * and return the current chunk size. Earlier changes are not reported.
   * The listener runs inside the commit, so it must not use this database;
   * if it throws, the changes are reported again with the next commit.
   * @internal
   */
  onCommit(listener: (commit: Commit) => void): number {
    const wasm = this.wasm
    const callback = wasm.addFunction(
      (
        count: number,
        indexes: Pointer,
        chunks: Pointer,
        chunkSize: number,
        size: number,
        minSize: number
      ) => {
        // An exception must not unwind through SQLite's commit.
        try {
          const changed = new Map<number, Uint8Array>()
          for (let i = 0; i < count; i++) {
            const data = wasm.getValue(chunks + 4 * i, '*')
            // Chunk indexes are 64-bit, but fit the low 32 bits in Wasm.
            changed.set(
              wasm.getValue(indexes + 8 * i, 'i32'),
              wasm.HEAPU8.slice(data, data + chunkSize)
            )
          }
          listener({chunkSize, size, minSize, chunks: changed})
          return ReturnCode.OK
        } catch {
          return ReturnCode.ERROR
        }
      },
      'iiiiidd'
    )
    const chunkSize = wasm.alinea_persist(this.dbPtr, callback)
    if (chunkSize === 0) {
      wasm.removeFunction(callback)
      throw new Error('Unable to track commits')
    }
    if (this.commitListener) wasm.removeFunction(this.commitListener)
    this.commitListener = callback
    return chunkSize
  }

  /**
   * Report the whole committed database to the commit listener, as one
   * commit that replaces everything (`minSize` 0).
   * @internal
   */
  persistAll(): void {
    const result = this.wasm.alinea_persist_all(this.dbPtr)
    if (result !== ReturnCode.OK)
      throw new SQLiteError(this.wasm.sqlite3_errstr(result), result)
  }

  /** @internal */
  private stopCommits() {
    if (!this.commitListener) return
    this.wasm.alinea_persist(this.dbPtr, this.wasm.NULL)
    this.wasm.removeFunction(this.commitListener)
    this.commitListener = undefined
  }

  /**
   * Wait until every committed change is stored, for stored databases (see
   * `Database.sync` and `attach`). Rejects if storing failed; failed writes
   * are retried with the next commit or flush. After `detach()` or
   * `close()`, waits for the final write and rejects if it failed. Resolves
   * right away for in-memory databases.
   */
  flush(): Promise<void> {
    return this.persistence ? this.persistence.flush() : Promise.resolve()
  }

  /**
   * Stop storing this database and keep it in memory. The commits made so
   * far are still written; `flush()` waits for them. Later commits are not
   * stored, and syncing or attaching the same storage waits for the final
   * write, as after `close()`.
   */
  detach(): void {
    if (this.file !== undefined) return this.persistence?.detach?.()
    if (!this.commitListener) return
    this.stopCommits()
    this.persistence?.close()
  }

  /**
   * Execute an SQL query, ignoring the rows it returns.
   * @see [https://sql.js.org/documentation/Database.html#["run"]](https://sql.js.org/documentation/Database.html#%5B%22run%22%5D)
   *
   * @param sql a string containing some SQL text to execute
   * @param params When the SQL statement contains placeholders, you can
   * pass them in here. They will be bound to the statement before it is
   * executed. If you use the params argument as an array, you **cannot**
   * provide an sql string that contains several statements (separated by
   * `;`). This limitation does not apply to params as an object.
   */
  run(sql: string, params?: BindParams) {
    if (!this.dbPtr) {
      throw new Error('Database closed')
    }
    if (params) {
      const stmt = this.prepare(sql, params)
      try {
        stmt.step()
      } finally {
        stmt.free()
      }
    } else {
      this.handleError(
        this.wasm.sqlite3_exec(this.dbPtr, sql, 0, 0, this.wasm.tempInt32)
      )
    }
    return this
  }

  /**
   * Execute an SQL query, and returns the result.
   *
   * This is a wrapper against `Database.prepare`, `Statement.bind`, `Statement.step`, `Statement.get`, and `Statement.free`.
   *
   * The result is an array of result elements. There are as many result elements as the number of statements in your sql string (statements are separated by a semicolon)
   * @see [https://sql.js.org/documentation/Database.html#["exec"]](https://sql.js.org/documentation/Database.html#%5B%22exec%22%5D)
   *
   * @param sql a string containing some SQL text to execute
   * @param params When the SQL statement contains placeholders, you can
   * pass them in here. They will be bound to the statement before it is
   * executed. If you use the params argument as an array, you **cannot**
   * provide an sql string that contains several statements (separated by
   * `;`). This limitation does not apply to params as an object.
   */
  exec(sql: string, params?: BindParams): QueryExecResult[] {
    if (!this.dbPtr) {
      throw new Error('Database closed')
    }
    const stack = this.wasm.stackSave()
    try {
      const sqlLength = this.wasm.lengthBytesUTF8(sql) + 1
      let nextSqlPtr = this.wasm.stackAlloc(sqlLength)
      this.wasm.stringToUTF8(sql, nextSqlPtr, sqlLength)
      const pzTail = this.wasm.stackAlloc(4)
      const results: QueryResult[] = []
      while (this.wasm.getValue(nextSqlPtr, 'i8') !== this.wasm.NULL) {
        this.wasm.setValue(this.wasm.tempInt32, 0, '*')
        this.wasm.setValue(pzTail, 0, '*')
        this.handleError(
          this.wasm.sqlite3_prepare_v2_sqlptr(
            this.dbPtr,
            nextSqlPtr,
            -1,
            this.wasm.tempInt32,
            pzTail
          )
        )
        const stmtPtr = this.wasm.getValue(this.wasm.tempInt32, '*')
        nextSqlPtr = this.wasm.getValue(pzTail, '*')
        if (stmtPtr === this.wasm.NULL) {
          break
        }
        const stmt = new Statement(stmtPtr, this)
        if (params != null) {
          stmt.bind(params)
        }
        try {
          let inserted = false
          while (stmt.step()) {
            // eslint-disable-next-line max-depth
            if (!inserted) {
              inserted = true
              results.push({
                columns: stmt.getColumnNames(),
                values: []
              })
            }
            results[results.length - 1].values.push(stmt.get())
          }
        } finally {
          stmt.free()
        }
      }
      return results
    } finally {
      this.wasm.stackRestore(stack)
    }
  }

  /**
   * Execute an sql statement, and call a callback for each row of result.
   *
   * Currently this method is synchronous, it will not return until the
   * callback has been called on every row of the result. But this might
   * change.
   * @see [https://sql.js.org/documentation/Database.html#["each"]](https://sql.js.org/documentation/Database.html#%5B%22each%22%5D)
   *
   * @param sql A string of SQL text. Can contain placeholders that will
   * be bound to the parameters given as the second argument
   * @param params Parameters to bind to the query
   * @param callback Function to call on each row of result
   * @param done A function that will be called when all rows have been
   * retrieved
   */
  each(
    sql: string,
    params: BindParams,
    callback: ParamsCallback,
    done: () => void
  ): Database
  each(sql: string, callback: ParamsCallback, done: () => void): Database
  each(sql: string, ...args: any[]) {
    let stmt: Statement
    let doneCallback: () => any
    let rowCallback: (row: ReturnMap) => void
    if (typeof args[0] === 'function') {
      stmt = this.prepare(sql)
      rowCallback = args[0]
      doneCallback = args[1]
    } else {
      stmt = this.prepare(sql, args[0])
      rowCallback = args[1]
      doneCallback = args[2]
    }
    if (typeof rowCallback !== 'function') {
      throw new Error('No callback passed')
    }
    try {
      while (stmt.step()) {
        rowCallback(stmt.getAsObject())
      }
    } finally {
      stmt.free()
    }
    if (typeof doneCallback === 'function') {
      return doneCallback()
    } else {
      return this
    }
  }

  /**
   * Prepare an SQL statement
   * @see [https://sql.js.org/documentation/Database.html#["prepare"]](https://sql.js.org/documentation/Database.html#%5B%22prepare%22%5D)
   *
   * @param sql a string of SQL, that can contain placeholders (`?`, `:VVV`, `:AAA`, `@AAA`)
   * @param params values to bind to placeholders
   */
  prepare(sql: string, params?: BindParams): Statement {
    this.wasm.setValue(this.wasm.tempInt32, 0, '*')
    this.handleError(
      this.wasm.sqlite3_prepare_v2(
        this.dbPtr,
        sql,
        -1,
        this.wasm.tempInt32,
        this.wasm.NULL
      )
    )
    const stmtPtr = this.wasm.getValue(this.wasm.tempInt32, '*')
    if (stmtPtr === this.wasm.NULL) {
      throw new Error('Nothing to prepare. Check your SQL statement.')
    }
    const stmt = new Statement(stmtPtr, this)
    if (typeof params !== 'undefined') {
      stmt.bind(params)
    }
    this.statements[stmtPtr] = stmt
    return stmt
  }

  /**
   * Close DB, but not delete the DB file
   */
  private _close(): void {
    for (const [, stmt] of Object.entries(this.statements)) {
      stmt.free()
    }
    this.statements = {}
    for (const [, func] of Object.entries(this.functions)) {
      this.wasm.removeFunction(func)
    }
    this.functions = {}
    this.stopCommits()
    if (this.commitWatch) {
      this.wasm.sqlite3_commit_hook(this.dbPtr, this.wasm.NULL, this.wasm.NULL)
      this.wasm.removeFunction(this.commitWatch.pointer)
      this.commitWatch = undefined
    }
    this.persistence?.closing?.()
    try {
      this.handleError(this.wasm.sqlite3_close_v2(this.dbPtr))
    } finally {
      this.persistence?.close()
    }
  }

  /**
   * Exports the contents of the database to a binary array
   * @see [https://sql.js.org/documentation/Database.html#["export"]](https://sql.js.org/documentation/Database.html#%5B%22export%22%5D)
   */
  public export(): Uint8Array {
    if (!this.dbPtr) {
      throw new Error('Database closed')
    }
    const dataPtr = this.wasm.alinea_serialize(this.dbPtr, this.wasm.tempInt32)
    if (dataPtr === this.wasm.NULL) {
      throw new Error('Unable to serialize the database')
    }
    const byteLength = this.wasm.getValue(this.wasm.tempInt32, 'i32')
    try {
      return this.wasm.HEAPU8.slice(dataPtr, dataPtr + byteLength)
    } finally {
      this.wasm.sqlite3_free(dataPtr)
    }
  }

  /**
   * Close the database, and all associated prepared statements. The
   * memory associated to the database and all associated statements will
   * be freed.
   *
   * **Warning**: A statement belonging to a database that has been closed
   * cannot be used anymore.
   *
   * Databases must be closed when you're finished with them, or the
   * memory consumption will grow forever. Commits of a persistent database
   * that are not stored yet are still written after it closes; await
   * `flush()` first to know they were.
   * @see [https://sql.js.org/documentation/Database.html#["close"]](https://sql.js.org/documentation/Database.html#%5B%22close%22%5D)
   */
  public close() {
    this._close()
    this.dbPtr = this.wasm.NULL
  }

  /**
   * Analyze a result code, return null if no error occured, and throw an
   * error with a descriptive message otherwise
   * @see [https://sql.js.org/documentation/Database.html#["handleError"]](https://sql.js.org/documentation/Database.html#%5B%22handleError%22%5D)
   */
  // sql.js types are incorrect, so mark as optional
  handleError(returnCode?: ReturnCode): null | never {
    if (returnCode === ReturnCode.OK) {
      return null
    } else {
      throw new SQLiteError(
        this.wasm.sqlite3_errmsg(this.dbPtr),
        returnCode ?? ReturnCode.ERROR
      )
    }
  }

  /**
   * Iterate over multiple SQL statements in a SQL string. This function
   * returns an iterator over Statement objects. You can use a `for..of`
   * loop to execute the returned statements one by one.
   * @see [https://sql.js.org/documentation/Database.html#["iterateStatements"]](https://sql.js.org/documentation/Database.html#%5B%22iterateStatements%22%5D)
   *
   * @param sql a string of SQL that can contain multiple statements
   */
  iterateStatements(sql: string): StatementIterator {
    throw new Error('Not implemented')
  }

  /**
   * Returns the number of changed rows (modified, inserted or deleted) by
   * the latest completed `INSERT`, `UPDATE` or `DELETE` statement on the
   * database. Executing any other type of SQL statement does not modify
   * the value returned by this function.
   * @see [https://sql.js.org/documentation/Database.html#["getRowsModified"]](https://sql.js.org/documentation/Database.html#%5B%22getRowsModified%22%5D)
   */
  getRowsModified() {
    return this.wasm.sqlite3_changes(this.dbPtr)
  }

  /**
   * Register a custom function with SQLite
   * @see [https://sql.js.org/documentation/Database.html#["create_function"]](https://sql.js.org/documentation/Database.html#%5B%22create_function%22%5D)
   *
   * @param name the name of the function as referenced in SQL statements.
   * @param func the actual function to be executed.
   */
  create_function(name: string, func: Function) {
    const wrappedFunc = (
      sqlite3ContextPtr: Pointer,
      argc: number,
      argvPtr: Pointer
    ) => {
      const args = []
      for (let i = 0; i < argc; i++) {
        const valuePtr = this.wasm.getValue(argvPtr + 4 * i, '*')
        const valueType = this.wasm.sqlite3_value_type(valuePtr)
        const dataFunc = (() => {
          switch (false) {
            case valueType !== 1:
              return this.wasm.sqlite3_value_double
            case valueType !== 2:
              return this.wasm.sqlite3_value_double
            case valueType !== 3:
              return this.wasm.sqlite3_value_text
            case valueType !== 4:
              return (ptr: Pointer) => {
                const size = this.wasm.sqlite3_value_bytes(ptr)
                const blobPtr = this.wasm.sqlite3_value_blob(ptr)
                const blobArg = new Uint8Array(size)
                for (let j = 0; j < size; j++) {
                  // [TODO] Remove this ESLint disable
                  // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                  blobArg[j] = this.wasm.HEAPU8[blobPtr + j]
                }
                return blobArg
              }
            default:
              return (_: Pointer) => {
                return null
              }
          }
        })()
        args.push(dataFunc(valuePtr))
      }
      let result
      try {
        result = func(...args)
      } catch (error) {
        this.wasm.sqlite3_result_error(sqlite3ContextPtr, error, -1)
        return
      }
      switch (typeof result) {
        case 'boolean':
          this.wasm.sqlite3_result_int(sqlite3ContextPtr, result ? 1 : 0)
          break
        case 'number':
          this.wasm.sqlite3_result_double(sqlite3ContextPtr, result)
          break
        case 'string':
          this.wasm.sqlite3_result_text(sqlite3ContextPtr, result, -1, -1)
          break
        case 'object':
          if (result === null) {
            this.wasm.sqlite3_result_null(sqlite3ContextPtr)
          } else if (typeof result.length === 'number') {
            const blobPtr = this.wasm._malloc(result.length)
            this.wasm.HEAPU8.set(result, blobPtr)
            this.wasm.sqlite3_result_blob(
              sqlite3ContextPtr,
              blobPtr,
              result.length,
              -1
            )
            this.wasm._free(blobPtr)
          } else {
            this.wasm.sqlite3_result_error(
              sqlite3ContextPtr,
              `Wrong API use : tried to return a value of an unknown type (${result}).`,
              -1
            )
          }
          break
        default:
          this.wasm.sqlite3_result_null(sqlite3ContextPtr)
      }
    }
    if (name in this.functions) {
      this.wasm.removeFunction(this.functions[name])
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.functions[name]
    }
    // The signature of the wrapped function is :
    // void wrapped(sqlite3_context *db, int argc, sqlite3_value **argv)
    const funcPtr = this.wasm.addFunction(wrappedFunc, 'viii')
    this.functions[name] = funcPtr
    this.handleError(
      this.wasm.sqlite3_create_function_v2(
        this.dbPtr,
        name,
        func.length,
        ReturnCode.UTF8,
        0,
        funcPtr,
        0,
        0,
        0
      )
    )
    return this
  }
}
