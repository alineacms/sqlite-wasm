#!/bin/bash
# Builds the storage prototypes: SQLite with the package's flags plus the JS
# VFS (jsvfs.c), as plain Emscripten ES modules that fetch their .wasm.
#   dist/sync: the VFS answers synchronously (OPFS, retry-on-miss IndexedDB)
#   dist/jspi: the VFS may await (IndexedDB through JSPI)
# Run `bun run build` once first, so cache/ holds the generated amalgamation.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=prototypes/storage/dist
SRC=cache/sqlite-src-3530400
FLAGS=$(make -s --no-print-directory --eval 'flags: ; @echo $(EMCC_SQLITE_FLAGS) $(EMCC_OVERLAY_FLAGS)' flags)
EXPORTS='_malloc,_free,_jsvfs_open_db,_sqlite3_exec,_sqlite3_errmsg,_sqlite3_prepare_v2,_sqlite3_bind_text,_sqlite3_bind_double,_sqlite3_bind_null,_sqlite3_step,_sqlite3_reset,_sqlite3_clear_bindings,_sqlite3_finalize,_sqlite3_close_v2,_sqlite3_column_count,_sqlite3_column_name,_sqlite3_column_type,_sqlite3_column_double,_sqlite3_column_text,_sqlite3_column_bytes,_sqlite3_get_autocommit,_sqlite3_libversion'
# Every export that can reach the VFS must be able to suspend under JSPI.
SUSPENDING='jsvfs_open_db,sqlite3_exec,sqlite3_prepare_v2,sqlite3_step,sqlite3_reset,sqlite3_finalize,sqlite3_close_v2'
build() {
  local name=$1; shift
  mkdir -p "$OUT/$name"
  emcc -Oz -flto -fno-exceptions -sMALLOC=emmalloc -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
    -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    $FLAGS "$@" -I"$SRC" "$SRC/sqlite3.c" src/sqlite3-bridge.c src/overlay.c \
    prototypes/storage/jsvfs.c -o "$OUT/$name/sqlite.mjs"
}
build sync
IMPORTS='jsvfs_js_open,jsvfs_js_close,jsvfs_js_read,jsvfs_js_write,jsvfs_js_truncate,jsvfs_js_sync,jsvfs_js_size,jsvfs_js_delete,jsvfs_js_exists'
build jspi -sJSPI -sJSPI_EXPORTS="$SUSPENDING" -sJSPI_IMPORTS="$IMPORTS"
ls -l "$OUT"/*/sqlite.wasm
