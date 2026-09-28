// Names of SQLite's primary result codes, by number.
const names = [
  'OK', 'ERROR', 'INTERNAL', 'PERM', 'ABORT', 'BUSY', 'LOCKED', 'NOMEM',
  'READONLY', 'INTERRUPT', 'IOERR', 'CORRUPT', 'NOTFOUND', 'FULL', 'CANTOPEN',
  'PROTOCOL', 'EMPTY', 'SCHEMA', 'TOOBIG', 'CONSTRAINT', 'MISMATCH', 'MISUSE',
  'NOLFS', 'AUTH', 'FORMAT', 'RANGE', 'NOTADB', 'NOTICE', 'WARNING'
]

/**
 * An error reported by SQLite, or by the storage of a database. Check
 * `code`, such as `'SQLITE_CORRUPT'` or `'SQLITE_BUSY'`, rather than the
 * class: two copies of this package have two classes.
 */
export class SQLiteError extends Error {
  /** The name of the primary result code, such as `'SQLITE_CORRUPT'` */
  readonly code: string
  /** The result code, such as 11 for `SQLITE_CORRUPT` */
  readonly resultCode: number

  constructor(message: string, resultCode: number, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'SQLiteError'
    this.resultCode = resultCode
    this.code = `SQLITE_${names[resultCode & 0xff] ?? 'ERROR'}`
  }
}
