// The "js" VFS: files whose reads, writes, syncs and sizes are answered by
// Module.jsvfs in JavaScript, such as OPFS sync access handles (see
// opfs.ts). The overlay opens a writable base file and its redo journal
// through it (base=js), so a database is stored without keeping all of it
// in memory.
//
// Module.jsvfs answers synchronously. Locking is a no-op: the JavaScript
// side keeps one database per file.

#include "sqlite3.h"

#include <emscripten/em_js.h>
#include <string.h>

EM_JS_DEPS(jsvfs, "$UTF8ToString");

EM_JS(int, jsvfs_js_open, (const char *name, int flags), {
  return Module['jsvfs']['open'](UTF8ToString(name), flags);
});
EM_JS(int, jsvfs_js_close, (int id), {
  return Module['jsvfs']['close'](id);
});
EM_JS(int, jsvfs_js_read, (int id, void *data, int size, double offset), {
  return Module['jsvfs']['read'](id, data, size, offset);
});
EM_JS(int, jsvfs_js_write, (int id, const void *data, int size, double offset), {
  return Module['jsvfs']['write'](id, data, size, offset);
});
EM_JS(int, jsvfs_js_truncate, (int id, double size), {
  return Module['jsvfs']['truncate'](id, size);
});
EM_JS(int, jsvfs_js_sync, (int id), {
  return Module['jsvfs']['sync'](id);
});
EM_JS(double, jsvfs_js_size, (int id), {
  return Module['jsvfs']['size'](id);
});
EM_JS(int, jsvfs_js_delete, (const char *name), {
  return Module['jsvfs']['delete'](UTF8ToString(name));
});
EM_JS(int, jsvfs_js_exists, (const char *name), {
  return Module['jsvfs']['exists'](UTF8ToString(name));
});

typedef struct jsvfs_file {
  sqlite3_file base;
  int id;
} jsvfs_file;

static int jsvfs_close(sqlite3_file *file) {
  return jsvfs_js_close(((jsvfs_file *)file)->id);
}

static int jsvfs_read(sqlite3_file *file, void *data, int size, sqlite3_int64 offset) {
  return jsvfs_js_read(((jsvfs_file *)file)->id, data, size, (double)offset);
}

static int jsvfs_write(sqlite3_file *file, const void *data, int size, sqlite3_int64 offset) {
  return jsvfs_js_write(((jsvfs_file *)file)->id, data, size, (double)offset);
}

static int jsvfs_truncate(sqlite3_file *file, sqlite3_int64 size) {
  return jsvfs_js_truncate(((jsvfs_file *)file)->id, (double)size);
}

static int jsvfs_sync(sqlite3_file *file, int flags) {
  (void)flags;
  return jsvfs_js_sync(((jsvfs_file *)file)->id);
}

static int jsvfs_file_size(sqlite3_file *file, sqlite3_int64 *size) {
  double result = jsvfs_js_size(((jsvfs_file *)file)->id);
  if (result < 0) {
    return SQLITE_IOERR_FSTAT;
  }
  *size = (sqlite3_int64)result;
  return SQLITE_OK;
}

static int jsvfs_lock(sqlite3_file *file, int lock) {
  (void)file;
  (void)lock;
  return SQLITE_OK;
}

static int jsvfs_check_reserved_lock(sqlite3_file *file, int *result) {
  (void)file;
  *result = 0;
  return SQLITE_OK;
}

static int jsvfs_file_control(sqlite3_file *file, int op, void *arg) {
  (void)file;
  (void)op;
  (void)arg;
  return SQLITE_NOTFOUND;
}

static int jsvfs_sector_size(sqlite3_file *file) {
  (void)file;
  return 4096;
}

static int jsvfs_device_characteristics(sqlite3_file *file) {
  (void)file;
  return SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_SEQUENTIAL;
}

static const sqlite3_io_methods jsvfs_io = {
  1,
  jsvfs_close,
  jsvfs_read,
  jsvfs_write,
  jsvfs_truncate,
  jsvfs_sync,
  jsvfs_file_size,
  jsvfs_lock,
  jsvfs_lock,
  jsvfs_check_reserved_lock,
  jsvfs_file_control,
  jsvfs_sector_size,
  jsvfs_device_characteristics
};

static int jsvfs_open(
  sqlite3_vfs *vfs,
  sqlite3_filename name,
  sqlite3_file *file,
  int flags,
  int *out_flags
) {
  (void)vfs;
  jsvfs_file *js = (jsvfs_file *)file;
  js->base.pMethods = 0;
  if (name == 0) {
    return SQLITE_CANTOPEN;
  }
  int id = jsvfs_js_open(name, flags);
  if (id < 0) {
    return SQLITE_CANTOPEN;
  }
  js->id = id;
  js->base.pMethods = &jsvfs_io;
  if (out_flags) {
    *out_flags = flags;
  }
  return SQLITE_OK;
}

static int jsvfs_delete(sqlite3_vfs *vfs, const char *name, int sync_dir) {
  (void)vfs;
  (void)sync_dir;
  return jsvfs_js_delete(name);
}

static int jsvfs_access(sqlite3_vfs *vfs, const char *name, int flags, int *result) {
  (void)vfs;
  (void)flags;
  *result = jsvfs_js_exists(name);
  return SQLITE_OK;
}

static int jsvfs_full_pathname(sqlite3_vfs *vfs, const char *name, int size, char *output) {
  (void)vfs;
  sqlite3_snprintf(size, output, "%s", name);
  return SQLITE_OK;
}

// Register the VFS, with the default VFS's randomness, sleep and time.
int jsvfs_register(void) {
  static sqlite3_vfs vfs;
  sqlite3_vfs *fallback = sqlite3_vfs_find(0);
  if (fallback == 0) {
    return SQLITE_ERROR;
  }
  vfs = *fallback;
  vfs.iVersion = 2;
  vfs.szOsFile = sizeof(jsvfs_file);
  vfs.mxPathname = 512;
  vfs.pNext = 0;
  vfs.zName = "js";
  vfs.pAppData = 0;
  vfs.xOpen = jsvfs_open;
  vfs.xDelete = jsvfs_delete;
  vfs.xAccess = jsvfs_access;
  vfs.xFullPathname = jsvfs_full_pathname;
  return sqlite3_vfs_register(&vfs, 0);
}
