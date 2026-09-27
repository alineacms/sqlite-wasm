#include "sqlite3.h"
#include "overlay.h"

#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

static sqlite3_int64 alinea_unix_time_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0) {
    return 0;
  }
  return (sqlite3_int64)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int alinea_vfs_open(
  sqlite3_vfs *vfs,
  sqlite3_filename filename,
  sqlite3_file *file,
  int flags,
  int *out_flags
) {
  (void)vfs;
  (void)filename;
  (void)file;
  (void)flags;
  (void)out_flags;
  return SQLITE_CANTOPEN;
}

static int alinea_vfs_delete(sqlite3_vfs *vfs, const char *name, int sync_dir) {
  (void)vfs;
  (void)name;
  (void)sync_dir;
  return SQLITE_IOERR_DELETE;
}

static int alinea_vfs_access(
  sqlite3_vfs *vfs,
  const char *name,
  int flags,
  int *result
) {
  (void)vfs;
  (void)name;
  (void)flags;
  *result = 0;
  return SQLITE_OK;
}

static int alinea_vfs_full_pathname(
  sqlite3_vfs *vfs,
  const char *name,
  int output_size,
  char *output
) {
  (void)vfs;
  sqlite3_snprintf(output_size, output, "%s", name);
  return SQLITE_OK;
}

static int alinea_vfs_randomness(sqlite3_vfs *vfs, int size, char *output) {
  (void)vfs;
  uint32_t state = (uint32_t)alinea_unix_time_ms() ^ (uint32_t)(uintptr_t)output;
  for (int i = 0; i < size; i++) {
    state = state * 1664525u + 1013904223u;
    output[i] = (char)(state >> 24);
  }
  return size;
}

static int alinea_vfs_sleep(sqlite3_vfs *vfs, int microseconds) {
  (void)vfs;
  return microseconds;
}

static int alinea_vfs_current_time(sqlite3_vfs *vfs, double *julian_day) {
  (void)vfs;
  *julian_day = (double)alinea_unix_time_ms() / 86400000.0 + 2440587.5;
  return SQLITE_OK;
}

static int alinea_vfs_get_last_error(sqlite3_vfs *vfs, int size, char *output) {
  (void)vfs;
  (void)size;
  (void)output;
  return 0;
}

static int alinea_vfs_current_time_int64(sqlite3_vfs *vfs, sqlite3_int64 *time_ms) {
  (void)vfs;
  *time_ms = alinea_unix_time_ms() + 210866760000000LL;
  return SQLITE_OK;
}

static sqlite3_vfs alinea_vfs = {
  2,
  sizeof(sqlite3_file),
  1024,
  0,
  "alinea-memory",
  0,
  alinea_vfs_open,
  alinea_vfs_delete,
  alinea_vfs_access,
  alinea_vfs_full_pathname,
  0,
  0,
  0,
  0,
  alinea_vfs_randomness,
  alinea_vfs_sleep,
  alinea_vfs_current_time,
  alinea_vfs_get_last_error,
  alinea_vfs_current_time_int64,
  0,
  0,
  0
};

int sqlite3_os_init(void) {
  int result = sqlite3_vfs_register(&alinea_vfs, 1);
  if (result != SQLITE_OK) {
    return result;
  }
  return sqlite3_overlay_register(0);
}

int sqlite3_os_end(void) {
  return SQLITE_OK;
}

// Every database is a named copy-on-write overlay (see overlay.c), so forks
// share unchanged pages with their source.
static int alinea_open_overlay(sqlite3 **db, const char *from) {
  static unsigned int counter = 0;
  int result = sqlite3_initialize();
  if (result != SQLITE_OK) {
    return result;
  }
  unsigned int id = ++counter;
  char *uri = from
    ? sqlite3_mprintf("file:db%u?overlay=db%u&from=%s", id, id, from)
    : sqlite3_mprintf("file:db%u?overlay=db%u", id, id);
  if (uri == 0) {
    return SQLITE_NOMEM;
  }
  result = sqlite3_open_v2(
    uri,
    db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI,
    "overlay"
  );
  sqlite3_free(uri);
  return result;
}

int alinea_open(sqlite3 **db) {
  return alinea_open_overlay(db, 0);
}

// Opens a snapshot of the last committed state of source.
int alinea_fork(sqlite3 *source, sqlite3 **db) {
  const char *name =
    sqlite3_uri_parameter(sqlite3_db_filename(source, "main"), "overlay");
  if (name == 0) {
    *db = 0;
    return SQLITE_MISUSE;
  }
  return alinea_open_overlay(db, name);
}

unsigned char *alinea_malloc(int size) {
  return sqlite3_malloc(size);
}

// Appends a chunk of a database image to a freshly opened database, stored
// in chunks of chunk_size bytes (0: the page size). Once the last chunk is
// in, the header is read so the connection reports the image's page size
// right away; an invalid image still fails on first use.
int alinea_load(
  sqlite3 *db,
  const unsigned char *data,
  int size,
  int offset,
  int total,
  int chunk_size
) {
  int result =
    sqlite3_overlay_load(db, "main", data, size, offset, chunk_size);
  if (result == SQLITE_OK && offset + size == total) {
    sqlite3_exec(db, "select 1 from sqlite_schema limit 0", 0, 0, 0);
  }
  return result;
}

unsigned char *alinea_serialize(sqlite3 *db, int *size) {
  sqlite3_int64 byte_length = 0;
  unsigned char *data = sqlite3_serialize(db, "main", &byte_length, 0);
  if (data == 0 || byte_length > INT_MAX) {
    sqlite3_free(data);
    *size = 0;
    return 0;
  }
  *size = (int)byte_length;
  return data;
}

// A JavaScript function, added with addFunction, that receives the chunks a
// commit changed: their count, an array of 64-bit chunk indexes, an array of
// pointers to their content, the chunk size, the new file size and the
// smallest size the file had during the commit. It returns SQLITE_OK, or an
// error to have the changes reported again with the next commit.
typedef int (*alinea_commit_listener)(
  int count,
  const sqlite3_int64 *indexes,
  const unsigned char *const *chunks,
  int chunk_size,
  double file_size,
  double min_file_size
);

static int alinea_on_commit(void *arg, const sqlite3_overlay_commit *commit) {
  return ((alinea_commit_listener)arg)(
    commit->nChunk,
    commit->aiChunk,
    commit->apChunk,
    commit->szChunk,
    (double)commit->szFile,
    (double)commit->szMin
  );
}

// Calls listener after every commit that changes db, or stops calling a
// listener when it is null. Returns the chunk size, or 0 on error.
int alinea_persist(sqlite3 *db, alinea_commit_listener listener) {
  int chunk_size = 0;
  int result = sqlite3_overlay_commit_hook(
    db,
    "main",
    listener ? alinea_on_commit : 0,
    (void *)listener,
    &chunk_size
  );
  return result == SQLITE_OK ? chunk_size : 0;
}
