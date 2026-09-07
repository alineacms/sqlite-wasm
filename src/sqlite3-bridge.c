#include "sqlite3.h"

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
  return sqlite3_vfs_register(&alinea_vfs, 1);
}

int sqlite3_os_end(void) {
  return SQLITE_OK;
}

int alinea_open(sqlite3 **db) {
  int result = sqlite3_initialize();
  if (result != SQLITE_OK) {
    return result;
  }
  return sqlite3_open_v2(
    ":memory:",
    db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_MEMORY,
    "alinea-memory"
  );
}

unsigned char *alinea_malloc(int size) {
  return sqlite3_malloc(size);
}

int alinea_deserialize(sqlite3 *db, unsigned char *data, int size) {
  int result = sqlite3_deserialize(
    db,
    "main",
    data,
    size,
    size,
    SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (result != SQLITE_OK) {
    sqlite3_free(data);
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
