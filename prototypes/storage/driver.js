// The smallest SQLite driver over the raw exports, for the storage
// prototypes: open, exec, query (with statements cached by SQL text) and
// close. Rows are returned as objects, as in Statement.getAsObject.
//
// createDriver works with the synchronous build. createAsyncDriver awaits
// every export that can reach the VFS, for the JSPI build, where those
// exports return Promises.

const SQLITE_ROW = 100
const SQLITE_DONE = 101
const SQLITE_TRANSIENT = -1
const decoder = new TextDecoder()
const encoder = new TextEncoder()

export class SQLiteError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function cString(module, text) {
  const bytes = encoder.encode(text)
  const ptr = module._malloc(bytes.length + 1)
  module.HEAPU8.set(bytes, ptr)
  module.HEAPU8[ptr + bytes.length] = 0
  return ptr
}

function readText(module, ptr, length) {
  return decoder.decode(module.HEAPU8.subarray(ptr, ptr + length))
}

function readCString(module, ptr) {
  const heap = module.HEAPU8
  let end = ptr
  while (heap[end]) end++
  return decoder.decode(heap.subarray(ptr, end))
}

function bind(module, stmt, params) {
  for (let i = 0; i < params.length; i++) {
    const value = params[i]
    let rc
    if (value === null || value === undefined) {
      rc = module._sqlite3_bind_null(stmt, i + 1)
    } else if (typeof value === 'number') {
      rc = module._sqlite3_bind_double(stmt, i + 1, value)
    } else {
      const bytes = encoder.encode(String(value))
      const ptr = module._malloc(bytes.length)
      module.HEAPU8.set(bytes, ptr)
      rc = module._sqlite3_bind_text(stmt, i + 1, ptr, bytes.length, SQLITE_TRANSIENT)
      module._free(ptr)
    }
    if (rc) throw new SQLiteError(`bind failed (${rc})`, rc)
  }
}

function readRow(module, stmt, names) {
  const row = {}
  for (let col = 0; col < names.length; col++) {
    switch (module._sqlite3_column_type(stmt, col)) {
      case 1:
      case 2:
        row[names[col]] = module._sqlite3_column_double(stmt, col)
        break
      case 3: {
        const ptr = module._sqlite3_column_text(stmt, col)
        row[names[col]] = readText(module, ptr, module._sqlite3_column_bytes(stmt, col))
        break
      }
      default:
        row[names[col]] = null
    }
  }
  return row
}

function columnNames(module, stmt) {
  const names = []
  const count = module._sqlite3_column_count(stmt)
  for (let col = 0; col < count; col++) {
    names.push(readCString(module, module._sqlite3_column_name(stmt, col)))
  }
  return names
}

// $n placeholders become SQLite's ?n form, as in the SQLite adapter.
const toSQLite = (sql) => sql.replace(/\$(\d+)/g, '?$1')

export function createDriver(module) {
  let db = 0
  const statements = new Map()
  const out = module._malloc(4)
  const fail = (rc) => {
    throw new SQLiteError(readCString(module, module._sqlite3_errmsg(db)), rc)
  }
  const view = () => new Int32Array(module.HEAPU8.buffer, out, 1)
  const prepare = (sql) => {
    let entry = statements.get(sql)
    if (entry) return entry
    const text = cString(module, toSQLite(sql))
    const rc = module._sqlite3_prepare_v2(db, text, -1, out, 0)
    module._free(text)
    if (rc) fail(rc)
    entry = {stmt: view()[0], names: null}
    statements.set(sql, entry)
    return entry
  }
  return {
    open(name) {
      const text = cString(module, name)
      const rc = module._jsvfs_open_db(text, out)
      module._free(text)
      db = view()[0]
      if (rc) fail(rc)
      return readCString(module, module._sqlite3_libversion())
    },
    exec(sql) {
      const text = cString(module, sql)
      const rc = module._sqlite3_exec(db, text, 0, 0, 0)
      module._free(text)
      if (rc) fail(rc)
    },
    query(sql, params) {
      const entry = prepare(sql)
      const {stmt} = entry
      try {
        if (params?.length) bind(module, stmt, params)
        const rows = []
        let rc
        while ((rc = module._sqlite3_step(stmt)) === SQLITE_ROW) {
          entry.names ??= columnNames(module, stmt)
          rows.push(readRow(module, stmt, entry.names))
        }
        if (rc !== SQLITE_DONE) fail(rc)
        return rows
      } finally {
        module._sqlite3_reset(stmt)
        module._sqlite3_clear_bindings(stmt)
      }
    },
    inTransaction: () => db !== 0 && module._sqlite3_get_autocommit(db) === 0,
    close() {
      for (const {stmt} of statements.values()) module._sqlite3_finalize(stmt)
      statements.clear()
      const rc = module._sqlite3_close_v2(db)
      db = 0
      if (rc) throw new SQLiteError(`close failed (${rc})`, rc)
    },
  }
}

// The same driver for the JSPI build: exports that can reach the VFS
// return Promises.
export function createAsyncDriver(module) {
  let db = 0
  const statements = new Map()
  const out = module._malloc(4)
  const fail = (rc) => {
    throw new SQLiteError(readCString(module, module._sqlite3_errmsg(db)), rc)
  }
  const view = () => new Int32Array(module.HEAPU8.buffer, out, 1)
  const prepare = async (sql) => {
    let entry = statements.get(sql)
    if (entry) return entry
    const text = cString(module, toSQLite(sql))
    const rc = await module._sqlite3_prepare_v2(db, text, -1, out, 0)
    module._free(text)
    if (rc) fail(rc)
    entry = {stmt: view()[0], names: null}
    statements.set(sql, entry)
    return entry
  }
  return {
    async open(name) {
      const text = cString(module, name)
      const rc = await module._jsvfs_open_db(text, out)
      module._free(text)
      db = view()[0]
      if (rc) fail(rc)
      return readCString(module, module._sqlite3_libversion())
    },
    async exec(sql) {
      const text = cString(module, sql)
      const rc = await module._sqlite3_exec(db, text, 0, 0, 0)
      module._free(text)
      if (rc) fail(rc)
    },
    async query(sql, params) {
      const entry = await prepare(sql)
      const {stmt} = entry
      try {
        if (params?.length) bind(module, stmt, params)
        const rows = []
        let rc
        while ((rc = await module._sqlite3_step(stmt)) === SQLITE_ROW) {
          entry.names ??= columnNames(module, stmt)
          rows.push(readRow(module, stmt, entry.names))
        }
        if (rc !== SQLITE_DONE) fail(rc)
        return rows
      } finally {
        await module._sqlite3_reset(stmt)
        module._sqlite3_clear_bindings(stmt)
      }
    },
    async close() {
      for (const {stmt} of statements.values()) await module._sqlite3_finalize(stmt)
      statements.clear()
      const rc = await module._sqlite3_close_v2(db)
      db = 0
      if (rc) throw new SQLiteError(`close failed (${rc})`, rc)
    },
  }
}
