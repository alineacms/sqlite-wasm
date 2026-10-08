/**
 * Trible slash reference is used to explicitly prevent generating
 * import statement on JS side.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference types="emscripten" />

export interface SQLite3Wasm extends EmscriptenModule {
  // [TODO] Tye every functions properly
  sqlite3_exec: Function
  sqlite3_free: Function
  alinea_malloc: (size: number) => number
  alinea_open: (db: number) => number
  alinea_fork: (source: number, db: number) => number
  alinea_open_file: (file: string, db: number) => number
  alinea_open_base: (file: string, db: number) => number
  alinea_pages: (db: number, info: number, sizes: number) => number
  alinea_rebase: (db: number, snapshot: number, file: string) => number
  alinea_flush: (db: number) => number
  alinea_attach_file: (db: number, file: string) => number
  alinea_detach_file: (db: number, writeError: number) => number
  alinea_load: (
    db: number,
    data: number,
    size: number,
    offset: number,
    total: number,
    chunkSize: number
  ) => number
  alinea_serialize: (db: number, size: number) => number
  alinea_persist: (db: number, listener: number) => number
  alinea_persist_all: (db: number) => number
  sqlite3_errmsg: Function
  sqlite3_errstr: (code: number) => string
  sqlite3_txn_state: (db: number, schema: string) => number
  sqlite3_get_autocommit: (db: number) => number
  sqlite3_changes: Function
  sqlite3_prepare_v2: Function
  sqlite3_prepare_v2_sqlptr: Function
  sqlite3_bind_text: Function
  sqlite3_bind_blob: Function
  sqlite3_bind_double: Function
  sqlite3_bind_int: Function
  sqlite3_bind_parameter_index: Function
  sqlite3_step: Function
  sqlite3_data_count: Function
  sqlite3_column_double: Function
  sqlite3_column_text: Function
  sqlite3_column_blob: Function
  sqlite3_column_bytes: Function
  sqlite3_column_type: Function
  sqlite3_column_name: Function
  sqlite3_reset: Function
  sqlite3_clear_bindings: Function
  sqlite3_finalize: Function
  sqlite3_close_v2: Function
  sqlite3_create_function_v2: Function
  sqlite3_value_bytes: Function
  sqlite3_value_type: Function
  sqlite3_value_text: Function
  sqlite3_value_blob: Function
  sqlite3_value_double: Function
  sqlite3_result_double: Function
  sqlite3_result_null: Function
  sqlite3_result_text: Function
  sqlite3_result_blob: Function
  sqlite3_result_int: Function
  sqlite3_result_error: Function
  sqlite3_sql: Function
  sqlite3_normalized_sql: Function

  // Emscripten runtime functions from exported_runtime_methods.json
  cwrap: typeof cwrap
  stackAlloc: typeof stackAlloc
  stackSave: typeof stackSave
  stackRestore: typeof stackRestore
  getValue: typeof getValue
  setValue: typeof setValue
  lengthBytesUTF8: typeof lengthBytesUTF8
  stringToUTF8: typeof stringToUTF8
  addFunction: typeof addFunction
  removeFunction: typeof removeFunction
  _malloc(size: number): number
  // Raw exports, for the per-value calls where cwrap's overhead shows
  _sqlite3_data_count(stmt: number): number
  _sqlite3_column_type(stmt: number, col: number): number
  _sqlite3_column_double(stmt: number, col: number): number
  _sqlite3_column_text(stmt: number, col: number): number
  _sqlite3_column_blob(stmt: number, col: number): number
  _sqlite3_column_bytes(stmt: number, col: number): number
  _free(pointer: number): void
  HEAPU8: Uint8Array

  // Files of the "js" VFS (jsvfs.c), installed by opfs.ts
  jsvfs?: JSFiles

  // Extra fields by -post-js.js
  NULL: number // 0
  tempInt32: number // A temporary pointer located in stack.
}

declare const init: EmscriptenModuleFactory<SQLite3Wasm>
export default init

/** Answers the "js" VFS (jsvfs.c): files by id, SQLite result codes. */
export interface JSFiles {
  open(name: string, flags: number): number
  close(id: number): number
  read(id: number, ptr: number, size: number, offset: number): number
  write(id: number, ptr: number, size: number, offset: number): number
  truncate(id: number, size: number): number
  sync(id: number): number
  size(id: number): number
  delete(name: string): number
  exists(name: string): number
}
