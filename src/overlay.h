/*
** overlay.h - the API of the overlay VFS in overlay.c, for code that
** compiles overlay.c into SQLite (see sqlite3-bridge.c).
*/
#ifndef OVERLAY_H
#define OVERLAY_H

#include "sqlite3.h"

/* The changes of one commit, as passed to a commit hook. */
typedef struct sqlite3_overlay_commit sqlite3_overlay_commit;
struct sqlite3_overlay_commit {
  int szChunk;                          /* Bytes per chunk */
  int nChunk;                           /* Chunks written by the commit */
  const sqlite3_int64 *aiChunk;         /* Index of each written chunk */
  const unsigned char *const *apChunk;  /* Content of each, szChunk bytes */
  sqlite3_int64 szFile;                 /* File size after the commit */
  sqlite3_int64 szMin;                  /* Smallest size since last commit */
};

typedef int (*sqlite3_overlay_hook)(void*, const sqlite3_overlay_commit*);

int sqlite3_overlay_register(int makeDefault);
int sqlite3_overlay_load(
  sqlite3 *db,
  const char *zSchema,
  const void *pData,
  int nData,
  sqlite3_int64 iOfst,
  int szChunk
);
int sqlite3_overlay_commit_hook(
  sqlite3 *db,
  const char *zSchema,
  sqlite3_overlay_hook xCommit,
  void *pArg,
  int *pszChunk
);
int sqlite3_overlay_report_all(sqlite3 *db, const char *zSchema);
int sqlite3_overlay_flush(sqlite3 *db, const char *zSchema);
int sqlite3_overlay_attach_base(
  sqlite3 *db,
  const char *zSchema,
  const char *zVfs,
  const char *zPath
);
int sqlite3_overlay_detach_base(sqlite3 *db, const char *zSchema);

#endif
