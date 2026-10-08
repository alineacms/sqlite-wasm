/*
** overlay.c - a copy-on-write, in-memory overlay VFS for SQLite.
**
** Every change is kept in memory, page by page. Overlays can be forked
** cheaply: a fork shares all pages with its source and copies a page only
** when one side writes to it.
**
** Built as a loadable extension, an overlay sits on top of an existing
** database file that is opened strictly read-only. The file is never
** written and no journal or WAL files are created next to it:
**
**   file:base.db?vfs=overlay                  private overlay (one connection)
**   file:base.db?vfs=overlay&overlay=A        named overlay A; further opens
**                                             with overlay=A share it
**   file:base.db?vfs=overlay&overlay=C&from=A new overlay C, a snapshot of
**                                             A's committed state
**
** Compiled with -DOVERLAY_OMIT_BASE (the Wasm build, which has no file
** system) overlays have no base file: they start empty, or from= another
** overlay, and the filename is only a label.
**
**   file:base.db?vfs=overlay&overlay=A&base=VFS
**                                             named overlay A on a writable
**                                             base file of VFS, to which
**                                             every commit is written back
**                                             (see "Writable base files")
**   file:base.db?vfs=overlay&overlay=A&base=VFS&base_readonly=1
**                                             named overlay A on a read-only
**                                             base file of VFS, as without
**                                             base= (see "Read-only base files
**                                             of another VFS")
**
** Page storage
** ------------
** An overlay holds a table of pointers indexed by chunk number (a chunk is
** one database page). A NULL entry means "read this page from the base file".
** Pages are reference counted: `from=` copies the table of the source and
** bumps the reference count of every page, so forking is O(pages in table)
** pointer copies and no page data is duplicated. A write to a page that is
** referenced by more than one overlay first makes a private copy. This gives
** each overlay a point-in-time snapshot: later writes to A are not visible in
** C and vice versa, and C stays valid after A is closed.
**
** Lifetime
** --------
** An overlay lives as long as at least one connection has it open. When the
** last connection closes, its changes are discarded (unless its base file
** is writable: they were written there with every commit).
**
** Locking
** -------
** Connections sharing a named overlay are coordinated with in-process
** SHARED/RESERVED/PENDING/EXCLUSIVE locks (the same protocol the OS VFSes
** implement with file locks). A SHARED lock is held on the base file for as
** long as an overlay exists, so other SQLite connections cannot modify it.
**
** Reading the base file
** ---------------------
** Because the base file cannot change (unless it is writable, see below),
** its first page is kept in memory
** (SQLite rereads the header at the start of every transaction) and, with
** PRAGMA mmap_size, pages the overlay has not changed are memory-mapped
** straight from the base file instead of copied with xRead.
**
** Commit hook
** -----------
** sqlite3_overlay_commit_hook() reports the chunks every commit changed,
** which lets an embedder persist an overlay incrementally (the Wasm build
** writes them to IndexedDB). Changed chunks are tracked only while a hook is
** registered.
*/
#ifdef SQLITE_CORE
# include "sqlite3.h"
#else
# include "sqlite3ext.h"
  SQLITE_EXTENSION_INIT1
#endif
#include <string.h>
#include "overlay.h"

#define OVERLAY_VFS_NAME "overlay"
#define OVERLAY_DEFAULT_CHUNK 4096

#if defined(SQLITE_THREADSAFE) && SQLITE_THREADSAFE==0
# define ovEnter()
# define ovLeave()
#else
# define ovEnter() sqlite3_mutex_enter(gMutex)
# define ovLeave() sqlite3_mutex_leave(gMutex)
#endif

typedef sqlite3_int64 i64;
typedef unsigned char u8;

typedef struct OvPage OvPage;
typedef struct Overlay Overlay;
typedef struct OvFile OvFile;
typedef struct MemFile MemFile;

/* One page of modified data, shared between overlays by reference count. */
struct OvPage {
  int nRef;               /* Overlays referencing this page (guarded by gMutex) */
  u8 *a;                  /* szChunk bytes, allocated directly after the struct */
};

/* A copy-on-write layer, on top of one read-only base file if it has one. */
struct Overlay {
  char *zName;            /* Registry name, or NULL for a private overlay */
  const char *zPath;      /* Base path, from sqlite3_create_filename() */
  Overlay *pNext;         /* Next named overlay in gList */
  int nRef;               /* Open connections using this overlay */
  sqlite3_file *pBase;    /* Read-only handle on the base file, or NULL */
  OvPage *pHead;          /* First nHead bytes of the base file, or NULL */
  int nHead;              /* Bytes in pHead */
  i64 szMmap;             /* Memory-mapping limit of pBase (guarded by gMutex) */
  int szChunk;            /* Bytes per page-table entry */
  i64 szFile;             /* Virtual file size */
  i64 szVisible;          /* Prefix of the base file not truncated away */
  OvPage **apPage;        /* Page table, NULL entries read from base */
  i64 nPage;              /* Allocated entries in apPage */
  i64 nUsed;              /* Non-NULL entries in apPage */
  int nShared;            /* Connections holding SHARED or higher */
  OvFile *pWriter;        /* Connection holding RESERVED or higher */
  int eWriter;            /* Lock level held by pWriter */
  sqlite3_overlay_hook xCommit; /* Commit hook, or NULL */
  void *pCommitArg;       /* First argument to xCommit */
  u8 *aDirty;             /* Bitmap of chunks written since the last commit */
  i64 nDirtyBit;          /* Bits in aDirty */
  i64 *aiDirty;           /* The same chunks as a list */
  i64 nDirty;             /* Entries in aiDirty */
  i64 nDirtyAlloc;        /* Allocated entries in aiDirty */
  i64 szCommitted;        /* File size at the last commit */
  i64 szMin;              /* Smallest file size since the last commit */
  sqlite3_vfs *pBaseVfs;  /* VFS of a writable base (base=), or NULL */
  sqlite3_file *pJournal; /* Redo journal next to a writable base */
  char *zJournal;         /* Its name */
  i64 szStored;           /* Size of a writable base file */
  int rcWrite;            /* Error of the last write-back, or SQLITE_OK */
  int bChanging;          /* The base is writable, here or in its source */
  int bBorrowed;          /* pBase is that of the overlay it came from */
  i64 iJournal;           /* End of the last record in the redo journal */
  unsigned int nSeq;      /* Sequence number of the next record */
  unsigned int salt;      /* Salt of the records since the last checkpoint */
  sqlite3_vfs *pRoVfs;    /* VFS of a read-only base (base_readonly=1), or NULL */
};

/* An open main database file. */
struct OvFile {
  sqlite3_file base;
  Overlay *pOv;
  int eLock;
  i64 szMmap;             /* This connection's PRAGMA mmap_size */
};

/* A private in-memory file used for journals and WAL files. */
struct MemFile {
  sqlite3_file base;
  u8 *a;
  i64 sz;
  i64 nAlloc;
};

static sqlite3_vfs *gOrig;        /* The underlying OS VFS */
static sqlite3_mutex *gMutex;     /* Guards gList, lock state and page refs */
static Overlay *gList;            /* Named overlays */

/* ------------------------------------------------------------------------ */
/* Pages                                                                    */
/* ------------------------------------------------------------------------ */

static OvPage *ovPageAlloc(int sz){
  OvPage *p = sqlite3_malloc64(sizeof(OvPage) + sz);
  if( p ){
    p->nRef = 1;
    p->a = (u8*)&p[1];
  }
  return p;
}

/* Drop every page at index iFirst and above. Caller holds gMutex. */
static void ovDropPagesLocked(Overlay *ov, i64 iFirst){
  i64 i;
  for(i=iFirst; i<ov->nPage; i++){
    OvPage *p = ov->apPage[i];
    if( p ){
      if( --p->nRef==0 ) sqlite3_free(p);
      ov->apPage[i] = 0;
      ov->nUsed--;
    }
  }
}

/*
** Header bytes 18/19 are the read/write format versions; 2 means WAL. The
** overlay has no shared memory, so a database image is presented in
** rollback-journal mode. Its content is identical once checkpointed.
*/
static void ovPatchWal(u8 *buf, int n, i64 off){
  int k;
  for(k=18; k<20; k++){
    if( k>=off && k<off+n && buf[k-off]==2 ) buf[k-off] = 1;
  }
}

static int ovIsHeader(const u8 *h){
  return memcmp(h, "SQLite format 3", 16)==0;
}

static int ovIsWalHeader(const u8 *h){
  return ovIsHeader(h) && (h[18]==2 || h[19]==2);
}

/* Use the page size of a database header as the chunk size. */
static void ovUsePageSize(Overlay *ov, const u8 *h){
  int pgsz;
  if( !ovIsHeader(h) ) return;
  pgsz = (h[16]<<8) | h[17];
  if( pgsz==1 ) pgsz = 65536;
  if( pgsz>=512 && pgsz<=65536 && (pgsz & (pgsz-1))==0 ) ov->szChunk = pgsz;
}

/*
** Read from the base file, of which the first chunk is kept in memory. Bytes
** past its end read as zero.
*/
static int ovBaseRead(Overlay *ov, u8 *buf, int n, i64 off){
  int rc;
  if( off<ov->nHead ){
    int k = ov->nHead-off<n ? (int)(ov->nHead-off) : n;
    memcpy(buf, ov->pHead->a+off, k);
    if( k==n ) return SQLITE_OK;
    buf += k;
    n -= k;
    off += k;
  }
  /* Its base file was taken away before all of it could be copied. */
  if( ov->pBase==0 ) return SQLITE_IOERR_READ;
  rc = ov->pBase->pMethods->xRead(ov->pBase, buf, n, off);
  if( rc==SQLITE_IOERR_SHORT_READ ) rc = SQLITE_OK;
  return rc;
}

/*
** Keep the first chunk of the base file in memory: SQLite reads the header
** at the start of every transaction to see if the database changed. The
** header also tells the page size, which becomes the chunk size.
*/
static int ovReadHead(Overlay *ov, i64 szBase){
  int n, rc;
  if( szBase>=100 ){
    u8 h[100];
    rc = ov->pBase->pMethods->xRead(ov->pBase, h, 100, 0);
    if( rc!=SQLITE_OK ) return rc;
    ovUsePageSize(ov, h);
  }
  ov->pHead = ovPageAlloc(ov->szChunk);
  if( ov->pHead==0 ) return SQLITE_NOMEM;
  n = szBase<ov->szChunk ? (int)szBase : ov->szChunk;
  rc = ov->pBase->pMethods->xRead(ov->pBase, ov->pHead->a, n, 0);
  if( rc==SQLITE_IOERR_SHORT_READ ) rc = SQLITE_OK;
  if( rc!=SQLITE_OK ) return rc;
  if( n<ov->szChunk ) memset(ov->pHead->a+n, 0, (size_t)(ov->szChunk-n));
  if( n>=100 && ovIsWalHeader(ov->pHead->a) ) ovPatchWal(ov->pHead->a, 20, 0);
  ov->nHead = ov->szChunk;
  return SQLITE_OK;
}

/* Fill a page buffer with the lower layer's content for chunk iChunk. */
static int ovFillChunk(Overlay *ov, i64 iChunk, u8 *a){
  i64 iStart = iChunk*ov->szChunk;
  i64 n = ov->szVisible - iStart;
  if( n>ov->szChunk ) n = ov->szChunk;
  if( n<0 ) n = 0;
  if( n>0 ){
    int rc = ovBaseRead(ov, a, (int)n, iStart);
    if( rc!=SQLITE_OK ) return rc;
  }
  if( n<ov->szChunk ) memset(a+n, 0, (size_t)(ov->szChunk-n));
  return SQLITE_OK;
}

/*
** Return a page for chunk i that this overlay may modify, copying it out of
** the base file or away from other overlays first if needed. If bFull is
** set the caller will overwrite the whole page, so a new page is not filled.
*/
static int ovPageForWrite(Overlay *ov, i64 i, int bFull, OvPage **ppOut){
  OvPage *p, *pNew;
  if( i>=ov->nPage ){
    i64 nNew = ov->nPage ? ov->nPage*2 : 64;
    OvPage **ap;
    while( nNew<=i ) nNew *= 2;
    ap = sqlite3_realloc64(ov->apPage, nNew*sizeof(OvPage*));
    if( ap==0 ) return SQLITE_NOMEM;
    memset(ap+ov->nPage, 0, (size_t)(nNew-ov->nPage)*sizeof(OvPage*));
    ov->apPage = ap;
    ov->nPage = nNew;
  }
  p = ov->apPage[i];
  if( p ){
    int bShared;
    ovEnter();
    bShared = p->nRef>1;
    ovLeave();
    if( !bShared ){
      *ppOut = p;
      return SQLITE_OK;
    }
    /* Shared pages are never written, so copying outside the mutex is safe. */
    pNew = ovPageAlloc(ov->szChunk);
    if( pNew==0 ) return SQLITE_NOMEM;
    memcpy(pNew->a, p->a, ov->szChunk);
    ovEnter();
    if( --p->nRef==0 ) sqlite3_free(p);
    ovLeave();
  }else{
    pNew = ovPageAlloc(ov->szChunk);
    if( pNew==0 ) return SQLITE_NOMEM;
    if( !bFull ){
      int rc = ovFillChunk(ov, i, pNew->a);
      if( rc!=SQLITE_OK ){
        sqlite3_free(pNew);
        return rc;
      }
    }
    ov->nUsed++;
  }
  ov->apPage[i] = pNew;
  *ppOut = pNew;
  return SQLITE_OK;
}

/* ------------------------------------------------------------------------ */
/* Commit reporting                                                         */
/* ------------------------------------------------------------------------ */

/* Remember that chunk i was written, if a commit hook wants to know. */
static int ovMarkDirty(Overlay *ov, i64 i){
  if( ov->xCommit==0 && ov->pBaseVfs==0 ) return SQLITE_OK;
  if( i>=ov->nDirtyBit ){
    i64 nNew = ov->nDirtyBit ? ov->nDirtyBit*2 : 512;
    u8 *a;
    while( nNew<=i ) nNew *= 2;
    a = sqlite3_realloc64(ov->aDirty, nNew/8);
    if( a==0 ) return SQLITE_NOMEM;
    memset(a+ov->nDirtyBit/8, 0, (size_t)((nNew-ov->nDirtyBit)/8));
    ov->aDirty = a;
    ov->nDirtyBit = nNew;
  }
  if( ov->aDirty[i/8] & (1<<(i%8)) ) return SQLITE_OK;
  if( ov->nDirty==ov->nDirtyAlloc ){
    i64 nNew = ov->nDirtyAlloc ? ov->nDirtyAlloc*2 : 64;
    i64 *a = sqlite3_realloc64(ov->aiDirty, nNew*sizeof(i64));
    if( a==0 ) return SQLITE_NOMEM;
    ov->aiDirty = a;
    ov->nDirtyAlloc = nNew;
  }
  ov->aiDirty[ov->nDirty++] = i;
  ov->aDirty[i/8] |= (u8)(1<<(i%8));
  return SQLITE_OK;
}

/* Start tracking changes from the current state. */
static void ovResetDirty(Overlay *ov){
  i64 k;
  for(k=0; k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    ov->aDirty[i/8] &= (u8)~(1<<(i%8));
  }
  ov->nDirty = 0;
  ov->szCommitted = ov->szMin = ov->szFile;
}

/*
** Pass the chunks written since the last commit to the commit hook. Chunks
** that were truncated away are left out: every chunk at or past szMin that
** is not listed reads as zero (or from the base file, if there is one).
** Returns the error of the hook, or SQLITE_NOMEM; the changes are then
** reported again with the next commit.
*/
static int ovReportCommit(Overlay *ov){
  sqlite3_overlay_commit c;
  i64 nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  i64 *ai = 0;
  const u8 **ap = 0;
  i64 k;
  int rc;
  if( ov->xCommit==0 ) return SQLITE_OK;
  if( ov->nDirty==0 && ov->szFile==ov->szCommitted
   && ov->szMin==ov->szCommitted ){
    return SQLITE_OK;
  }
  if( ov->nDirty ){
    ai = sqlite3_malloc64(ov->nDirty*(sizeof(i64)+sizeof(u8*)));
    if( ai==0 ) return SQLITE_NOMEM;
    ap = (const u8**)&ai[ov->nDirty];
  }
  memset(&c, 0, sizeof(c));
  for(k=0; k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    if( i<nChunk && i<ov->nPage && ov->apPage[i] ){
      ai[c.nChunk] = i;
      ap[c.nChunk] = ov->apPage[i]->a;
      c.nChunk++;
    }
  }
  c.szChunk = ov->szChunk;
  c.aiChunk = ai;
  c.apChunk = ap;
  c.szFile = ov->szFile;
  c.szMin = ov->szMin;
  rc = ov->xCommit(ov->pCommitArg, &c);
  sqlite3_free(ai);
  if( rc==SQLITE_OK ) ovResetDirty(ov);
  return rc;
}

/* ------------------------------------------------------------------------ */
/* Overlay registry                                                         */
/* ------------------------------------------------------------------------ */

/* Caller holds gMutex. */
static Overlay *ovFind(const char *zName){
  Overlay *ov;
  for(ov=gList; ov; ov=ov->pNext){
    if( strcmp(ov->zName, zName)==0 ) return ov;
  }
  return 0;
}

/* True if overlay ov sits on the base file zName. */
static int ovSameBase(Overlay *ov, const char *zName){
#ifdef OVERLAY_OMIT_BASE
  (void)ov; (void)zName;
  return 1;
#else
  return strcmp(ov->zPath, zName)==0;
#endif
}

static int ovPreserveLocked(Overlay *ov, i64 iFirst, int bAll);
static void ovReleaseBorrowersLocked(Overlay *ov);
static int ovCheckpoint(Overlay *ov);
static int ovWriteBack(Overlay *ov);

/* Close the base file and its journal, if any, and forget them. */
static void ovCloseBase(Overlay *ov){
  if( ov->pBase && !ov->bBorrowed ){
    if( ov->pBase->pMethods ) ov->pBase->pMethods->xClose(ov->pBase);
    sqlite3_free(ov->pBase);
  }
  if( ov->pJournal ){
    if( ov->pJournal->pMethods ) ov->pJournal->pMethods->xClose(ov->pJournal);
    sqlite3_free(ov->pJournal);
  }
  sqlite3_free(ov->zJournal);
  if( ov->zPath ) sqlite3_free_filename((char*)ov->zPath);
  ov->pBase = ov->pJournal = 0;
  ov->zJournal = 0;
  ov->zPath = 0;
  ov->pBaseVfs = 0;
  ov->pRoVfs = 0;
  ov->bChanging = 0;
  ov->bBorrowed = 0;
  ov->rcWrite = SQLITE_OK;
}

/* Free an overlay whose last connection has closed. Caller holds gMutex. */
static void ovDestroyLocked(Overlay *ov){
  /* Its base file may change or go away from now on: snapshots that still
  ** read from it copy what they read. Leave the base file synced, so the
  ** journal is not needed. */
  if( ov->pBaseVfs ){
    ovReleaseBorrowersLocked(ov);
    ovCheckpoint(ov);
  }
  if( ov->zName ){
    Overlay **pp;
    for(pp=&gList; *pp; pp=&(*pp)->pNext){
      if( *pp==ov ){
        *pp = ov->pNext;
        break;
      }
    }
  }
  ovDropPagesLocked(ov, 0);
  sqlite3_free(ov->apPage);
  sqlite3_free(ov->aDirty);
  sqlite3_free(ov->aiDirty);
  if( ov->pHead && --ov->pHead->nRef==0 ) sqlite3_free(ov->pHead);
  ovCloseBase(ov);
  sqlite3_free(ov->zName);
  sqlite3_free(ov);
}

/*
** Read the memory-mapping limit of the base file into ov->szMmap, raising it
** to sz first if sz is larger. The base file handle is shared by every
** connection of the overlay, so its limit only grows: pages other
** connections hold stay mapped. While pages are out, the OS VFS keeps the
** old limit; callers try again later. Caller holds gMutex.
*/
static void ovMmapLimitLocked(Overlay *ov, i64 sz){
  sqlite3_file *pBase = ov->pBase;
  if( pBase==0 || pBase->pMethods->iVersion<3 ) return;
  if( sz>ov->szMmap
   && pBase->pMethods->xFileControl(pBase, SQLITE_FCNTL_MMAP_SIZE, &sz)
      !=SQLITE_OK ){
    return;
  }
  sz = -1;
  if( pBase->pMethods->xFileControl(pBase, SQLITE_FCNTL_MMAP_SIZE, &sz)
      ==SQLITE_OK && sz>=0 ){
    ov->szMmap = sz;
  }
}

/*
** Open the base file with VFS pVfs: read-only, locked against writers, or
** for a writable base (bWrite), read-write and locked exclusively.
*/
static int ovOpenBase(
  Overlay *ov,
  sqlite3_vfs *pVfs,
  const char *zPath,
  int bWrite,
  i64 *pSize
){
  int outFlags = 0;
  int flags = bWrite
    ? SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_MAIN_DB
    : SQLITE_OPEN_READONLY|SQLITE_OPEN_MAIN_DB;
  int rc;
  /* A private filename object keeps URI lookups by the OS VFS valid after
  ** the connection that created the overlay has closed. */
  ov->zPath = sqlite3_create_filename(zPath, "", "", 0, 0);
  ov->pBase = sqlite3_malloc(pVfs->szOsFile);
  if( ov->zPath==0 || ov->pBase==0 ) return SQLITE_NOMEM;
  memset(ov->pBase, 0, pVfs->szOsFile);
  rc = pVfs->xOpen(pVfs, ov->zPath, ov->pBase, flags, &outFlags);
  if( rc!=SQLITE_OK ) return rc;
  /* Keep other connections from modifying the base while we depend on it. */
  rc = ov->pBase->pMethods->xLock(ov->pBase, SQLITE_LOCK_SHARED);
  if( rc==SQLITE_OK && bWrite ){
    rc = ov->pBase->pMethods->xLock(ov->pBase, SQLITE_LOCK_RESERVED);
    if( rc==SQLITE_OK ){
      rc = ov->pBase->pMethods->xLock(ov->pBase, SQLITE_LOCK_EXCLUSIVE);
    }
  }
  if( rc!=SQLITE_OK ) return rc;
  /* The OS VFS may start from a default mapping limit. */
  ovMmapLimitLocked(ov, 0);
  return ov->pBase->pMethods->xFileSize(ov->pBase, pSize);
}

static int ovRecover(Overlay *ov);

/* Open a writable base file and its redo journal, finishing a write-back
** that was interrupted. */
static int ovOpenWritableBase(
  Overlay *ov,
  sqlite3_vfs *pVfs,
  const char *zPath,
  i64 *pSize
){
  int outFlags = 0;
  int rc = ovOpenBase(ov, pVfs, zPath, 1, pSize);
  if( rc!=SQLITE_OK ) return rc;
  ov->pBaseVfs = pVfs;
  ov->zJournal = sqlite3_mprintf("%s-journal", ov->zPath);
  ov->pJournal = sqlite3_malloc(pVfs->szOsFile);
  if( ov->zJournal==0 || ov->pJournal==0 ) return SQLITE_NOMEM;
  memset(ov->pJournal, 0, pVfs->szOsFile);
  rc = pVfs->xOpen(pVfs, ov->zJournal, ov->pJournal,
      SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_MAIN_JOURNAL,
      &outFlags);
  if( rc==SQLITE_OK ) rc = ovRecover(ov);
  if( rc==SQLITE_OK ) rc = ov->pBase->pMethods->xFileSize(ov->pBase, pSize);
  return rc;
}

/*
** Create an overlay on base file zPath, optionally as a snapshot of pSrc.
** Caller holds gMutex.
*/
static int ovCreateLocked(
  const char *zPath,
  const char *zName,
  Overlay *pSrc,
  Overlay **ppOut
){
  Overlay *ov;
  i64 szBase = 0;
  const char *zBaseVfs;
  int rc = SQLITE_OK;

  ov = sqlite3_malloc(sizeof(*ov));
  if( ov==0 ) return SQLITE_NOMEM;
  memset(ov, 0, sizeof(*ov));
  ov->nRef = 1;
  ov->szChunk = OVERLAY_DEFAULT_CHUNK;
  if( zName && (ov->zName = sqlite3_mprintf("%s", zName))==0 ){
    rc = SQLITE_NOMEM;
    goto failed;
  }

  zBaseVfs = sqlite3_uri_parameter(zPath, "base");
  if( zBaseVfs ){
    sqlite3_vfs *pVfs = sqlite3_vfs_find(zBaseVfs);
    if( pVfs==0 || strcmp(zBaseVfs, OVERLAY_VFS_NAME)==0 || pSrc ){
      sqlite3_log(SQLITE_CANTOPEN, pSrc
          ? "overlay: base= and from= cannot be combined"
          : "overlay: no VFS '%s' for the base file", zBaseVfs);
      rc = SQLITE_CANTOPEN;
    }else if( sqlite3_uri_boolean(zPath, "base_readonly", 0) ){
      rc = ovOpenBase(ov, pVfs, zPath, 0, &szBase);
      ov->pRoVfs = pVfs;
    }else{
      rc = ovOpenWritableBase(ov, pVfs, zPath, &szBase);
      ov->bChanging = 1;
    }
  }else if( pSrc && pSrc->bChanging ){
    /* A snapshot of an overlay on a writable base (or of a snapshot of
    ** one) reads the same file, through the same handle: the writable
    ** overlay keeps what it reads from changing, and lets go of it when
    ** it closes (ovPreserveLocked, ovReleaseBorrowersLocked). */
    ov->pBase = pSrc->pBase;
    ov->bBorrowed = ov->bChanging = 1;
    ov->zPath = sqlite3_create_filename(pSrc->zPath, "", "", 0, 0);
    if( ov->zPath==0 ) rc = SQLITE_NOMEM;
  }else if( pSrc && pSrc->pRoVfs ){
    /* A snapshot of an overlay on a read-only base of another VFS opens
    ** the same file. The base never changes, so each has its own handle
    ** and outlives the other. */
    rc = ovOpenBase(ov, pSrc->pRoVfs, pSrc->zPath, 0, &szBase);
    ov->pRoVfs = pSrc->pRoVfs;
  }else{
#ifndef OVERLAY_OMIT_BASE
    rc = ovOpenBase(ov, gOrig, zPath, 0, &szBase);
#endif
  }
  if( rc!=SQLITE_OK ) goto failed;

  if( pSrc ){
    i64 i;
    ov->szChunk = pSrc->szChunk;
    ov->pHead = pSrc->pHead;
    ov->nHead = pSrc->nHead;
    if( ov->pHead ) ov->pHead->nRef++;
    ov->szFile = pSrc->szFile;
    ov->szVisible = pSrc->szVisible;
    if( pSrc->nPage ){
      ov->apPage = sqlite3_malloc64(pSrc->nPage*sizeof(OvPage*));
      if( ov->apPage==0 ){
        rc = SQLITE_NOMEM;
        goto failed;
      }
      memcpy(ov->apPage, pSrc->apPage, (size_t)pSrc->nPage*sizeof(OvPage*));
      ov->nPage = pSrc->nPage;
      ov->nUsed = pSrc->nUsed;
      for(i=0; i<ov->nPage; i++){
        if( ov->apPage[i] ) ov->apPage[i]->nRef++;
      }
    }
  }else if( szBase>0 ){
    rc = ovReadHead(ov, szBase);
    if( rc!=SQLITE_OK ) goto failed;
    ov->szFile = ov->szVisible = szBase;
  }
  ov->szStored = szBase;

  if( ov->zName ){
    ov->pNext = gList;
    gList = ov;
  }
  *ppOut = ov;
  return SQLITE_OK;

failed:
  ovDestroyLocked(ov);
  return rc;
}

/* ------------------------------------------------------------------------ */
/* Writable base files                                                      */
/* ------------------------------------------------------------------------ */
/*
** With base=VFS, the base file is opened read-write through that VFS and
** every commit is written back to it, after which the overlay drops its
** copies of the written chunks and reads them from the base again. Only
** the chunks of the open transaction are kept in memory.
**
** Commits are made durable in a redo journal next to the base file (its
** name plus "-journal"), much like write-ahead logging: a write-back appends
** a record of the chunks to the journal and syncs only that, then writes
** them to the base file without syncing it. Once the journal holds more
** than OV_JOURNAL_LIMIT bytes, and when the overlay closes or detaches, the
** base file is synced and the journal starts over (a checkpoint). Opening
** the base replays the journal, so after a crash the base again holds the
** last commit. A record:
**
**   header   "OVREDO02", salt (4), sequence number (4), chunk size (4),
**            chunk count (4), file size (8)
**   entries  chunk index (8) and chunk content, per chunk
**   trailer  checksum (4), chunk count (4), "OVCOMMIT"
**
** Integers are big-endian; the checksum covers the header and entries.
** Records follow each other from the start of the journal with one salt and
** consecutive sequence numbers, and replay stops at the first record that
** is incomplete or does not follow. A checkpoint clears the first header
** and picks a new salt, so records left from before can never follow.
**
** Snapshots (from=) of an overlay on a writable base read the same file.
** Before a chunk they still read from it changes, they get a private copy
** of it, so they keep their point-in-time view; when the writable overlay
** closes, they copy every chunk they read from the base. Only named
** overlays are found this way, as every overlay with from= is.
*/

#define OV_REDO_HEADER 32
#define OV_REDO_TRAILER 16
#define OV_JOURNAL_LIMIT (4<<20)

static void ovPut32(u8 *a, unsigned int v){
  a[0] = (u8)(v>>24); a[1] = (u8)(v>>16); a[2] = (u8)(v>>8); a[3] = (u8)v;
}

static unsigned int ovGet32(const u8 *a){
  return ((unsigned int)a[0]<<24) | ((unsigned int)a[1]<<16)
       | ((unsigned int)a[2]<<8) | a[3];
}

static void ovPut64(u8 *a, i64 v){
  ovPut32(a, (unsigned int)((sqlite3_uint64)v>>32));
  ovPut32(a+4, (unsigned int)v);
}

static i64 ovGet64(const u8 *a){
  return (i64)(((sqlite3_uint64)ovGet32(a)<<32) | ovGet32(a+4));
}

static unsigned int ovChecksum(unsigned int s, const u8 *a, i64 n){
  i64 k;
  for(k=0; k<n; k++) s = s*31 + a[k];
  return s;
}

/* Give overlay o its own copy of chunk i, if it reads it from the base. */
static int ovPreserveChunk(Overlay *o, i64 i){
  OvPage *pg;
  if( i*o->szChunk>=o->szVisible ) return SQLITE_OK;
  if( i<o->nPage && o->apPage[i] ) return SQLITE_OK;
  /* A missing entry means an unshared page: no mutex needed. */
  return ovPageForWrite(o, i, 0, &pg);
}

/*
** Before the writable overlay ov changes its base file: give every other
** overlay on that file a copy of the chunks it reads from the base and ov
** is about to change, its dirty chunks and every chunk from iFirst on (all
** of them with bAll). Caller holds gMutex, if there is one.
*/
static int ovPreserveLocked(Overlay *ov, i64 iFirst, int bAll){
  Overlay *o;
  for(o=gList; o; o=o->pNext){
    i64 k, i, nVisible;
    int rc = SQLITE_OK;
    if( o==ov || !o->bBorrowed || o->pBase!=ov->pBase ) continue;
    nVisible = (o->szVisible+o->szChunk-1)/o->szChunk;
    if( bAll ) iFirst = 0;
    for(i=iFirst; rc==SQLITE_OK && i<nVisible; i++){
      rc = ovPreserveChunk(o, i);
    }
    for(k=0; rc==SQLITE_OK && !bAll && k<ov->nDirty; k++){
      rc = ovPreserveChunk(o, ov->aiDirty[k]);
    }
    if( rc!=SQLITE_OK ) return rc;
  }
  return SQLITE_OK;
}

/*
** Before the writable overlay ov closes its base file: give the overlays
** that borrowed it a copy of every chunk they read from it, and take the
** base away from them. If copying fails, the chunks they lack fail to read
** (see ovBaseRead) rather than read as zeros. Caller holds gMutex, if any.
*/
static void ovReleaseBorrowersLocked(Overlay *ov){
  Overlay *o;
  for(o=gList; o; o=o->pNext){
    i64 i, nVisible;
    int rc = SQLITE_OK;
    if( o==ov || !o->bBorrowed || o->pBase!=ov->pBase ) continue;
    nVisible = (o->szVisible+o->szChunk-1)/o->szChunk;
    for(i=0; rc==SQLITE_OK && i<nVisible; i++) rc = ovPreserveChunk(o, i);
    o->pBase = 0;
    o->bBorrowed = o->bChanging = 0;
    if( rc==SQLITE_OK ) o->szVisible = 0;
  }
}

/*
** Give an overlay that borrows a base file, or reads a read-only base of
** another VFS, a copy of every chunk it reads from it, and let go of the
** base, so it can be stored elsewhere.
*/
static int ovUnborrow(Overlay *ov){
  i64 i, nVisible;
  int rc = SQLITE_OK;
  if( !ov->bBorrowed && !ov->pRoVfs ) return SQLITE_OK;
  nVisible = (ov->szVisible+ov->szChunk-1)/ov->szChunk;
  for(i=0; rc==SQLITE_OK && i<nVisible; i++) rc = ovPreserveChunk(ov, i);
  if( rc!=SQLITE_OK ) return rc;
  if( ov->pRoVfs ){
    ovCloseBase(ov);
  }else{
    ov->pBase = 0;
    ov->bBorrowed = ov->bChanging = 0;
  }
  ov->szVisible = 0;
  return SQLITE_OK;
}

/* Start a new generation of journal records, from its start. */
static void ovNewJournal(Overlay *ov){
  unsigned int salt;
  do{
    sqlite3_randomness(sizeof(salt), &salt);
  }while( salt==ov->salt );
  ov->salt = salt;
  ov->iJournal = 0;
  ov->nSeq = 0;
}

/* Writes to the journal, gathered into fewer, larger writes. */
typedef struct OvWriter OvWriter;
struct OvWriter {
  sqlite3_file *pFile;
  u8 *a;                  /* Buffer of nAlloc bytes */
  int n;                  /* Bytes in the buffer */
  int nAlloc;
  i64 off;                /* File offset of the buffer */
  int rc;                 /* First error */
};

#define OV_WRITE_BUFFER (256*1024)

static void ovWriterFlush(OvWriter *w){
  if( w->rc==SQLITE_OK && w->n>0 ){
    w->rc = w->pFile->pMethods->xWrite(w->pFile, w->a, w->n, w->off);
  }
  w->off += w->n;
  w->n = 0;
}

static void ovWriterAppend(OvWriter *w, const u8 *data, int n){
  while( n>0 && w->rc==SQLITE_OK ){
    int k = w->nAlloc-w->n;
    if( k>n ) k = n;
    memcpy(w->a+w->n, data, k);
    w->n += k;
    data += k;
    n -= k;
    if( w->n==w->nAlloc ) ovWriterFlush(w);
  }
}

/*
** Append a record of the chunks written since the last write-back to the
** journal, and sync it: from then on the commit survives a crash.
*/
static int ovAppendJournal(Overlay *ov, i64 nChunk){
  sqlite3_file *pJ = ov->pJournal;
  u8 head[OV_REDO_HEADER], trail[OV_REDO_TRAILER], idx[8];
  OvWriter w;
  unsigned int cksum;
  i64 k, nByte;
  int nEntry = 0, rc;
  for(k=0; k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    if( i<nChunk && i<ov->nPage && ov->apPage[i] ) nEntry++;
  }
  nByte = OV_REDO_HEADER + nEntry*(8+(i64)ov->szChunk) + OV_REDO_TRAILER;
  memset(&w, 0, sizeof(w));
  w.pFile = pJ;
  w.off = ov->iJournal;
  w.nAlloc = nByte<OV_WRITE_BUFFER ? (int)nByte : OV_WRITE_BUFFER;
  w.a = sqlite3_malloc(w.nAlloc);
  if( w.a==0 ) return SQLITE_NOMEM;
  memcpy(head, "OVREDO02", 8);
  ovPut32(head+8, ov->salt);
  ovPut32(head+12, ov->nSeq);
  ovPut32(head+16, (unsigned int)ov->szChunk);
  ovPut32(head+20, (unsigned int)nEntry);
  ovPut64(head+24, ov->szFile);
  ovWriterAppend(&w, head, OV_REDO_HEADER);
  cksum = ovChecksum(0, head, OV_REDO_HEADER);
  for(k=0; k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    const u8 *a;
    if( i>=nChunk || i>=ov->nPage || ov->apPage[i]==0 ) continue;
    a = ov->apPage[i]->a;
    ovPut64(idx, i);
    ovWriterAppend(&w, idx, 8);
    ovWriterAppend(&w, a, ov->szChunk);
    cksum = ovChecksum(ovChecksum(cksum, idx, 8), a, ov->szChunk);
  }
  ovPut32(trail, cksum);
  ovPut32(trail+4, (unsigned int)nEntry);
  memcpy(trail+8, "OVCOMMIT", 8);
  ovWriterAppend(&w, trail, OV_REDO_TRAILER);
  ovWriterFlush(&w);
  sqlite3_free(w.a);
  rc = w.rc;
  if( rc==SQLITE_OK ) rc = pJ->pMethods->xSync(pJ, SQLITE_SYNC_NORMAL);
  if( rc==SQLITE_OK ){
    ov->iJournal += nByte;
    ov->nSeq++;
  }
  return rc;
}

/*
** Sync the base file, after which the journal is no longer needed: clear
** its first header and start a new generation. Only once every commit is
** written to the base file. If clearing is lost, replaying the records
** again does no harm.
*/
static int ovCheckpoint(Overlay *ov){
  static const u8 zero[OV_REDO_HEADER];
  sqlite3_file *pB = ov->pBase, *pJ = ov->pJournal;
  int rc;
  if( ov->iJournal==0 ) return SQLITE_OK;
  if( ov->nDirty || ov->rcWrite!=SQLITE_OK ) return SQLITE_OK;
  rc = pB->pMethods->xSync(pB, SQLITE_SYNC_NORMAL);
  if( rc==SQLITE_OK ) rc = pJ->pMethods->xWrite(pJ, zero, OV_REDO_HEADER, 0);
  if( rc==SQLITE_OK ) ovNewJournal(ov);
  return rc;
}

/*
** Store everything committed since the last write-back: append it to the
** journal, write it to the base file, and drop the written chunks from
** memory. On failure everything stays in memory and is written with the
** next commit.
*/
static int ovWriteBack(Overlay *ov){
  sqlite3_file *pB = ov->pBase;
  i64 nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  i64 k;
  int rc;
  if( ov->nDirty==0 && ov->szFile==ov->szStored ) return ov->rcWrite = SQLITE_OK;
  ovEnter();
  /* Chunks past the end change only if the base file shrinks. */
  rc = ovPreserveLocked(ov, ov->szFile<ov->szStored
      ? ov->szFile/ov->szChunk : ((i64)1)<<62, 0);
  ovLeave();
  if( rc==SQLITE_OK ) rc = ovAppendJournal(ov, nChunk);
  for(k=0; rc==SQLITE_OK && k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    i64 n = ov->szFile - i*ov->szChunk;
    if( i>=nChunk || i>=ov->nPage || ov->apPage[i]==0 ) continue;
    if( n>ov->szChunk ) n = ov->szChunk;
    rc = pB->pMethods->xWrite(pB, ov->apPage[i]->a, (int)n, i*ov->szChunk);
  }
  if( rc==SQLITE_OK && ov->szFile<ov->szStored ){
    rc = pB->pMethods->xTruncate(pB, ov->szFile);
  }
  if( rc==SQLITE_OK && nChunk>0 && ov->nPage>0 && ov->apPage[0] ){
    /* Keep the first chunk in memory, as for any base file. */
    OvPage *pHead = ov->pHead;
    if( pHead==0 || pHead->nRef>1 ){
      OvPage *pNew = ovPageAlloc(ov->szChunk);
      if( pNew==0 ){
        rc = SQLITE_NOMEM;
      }else{
        ovEnter();
        if( pHead && --pHead->nRef==0 ) sqlite3_free(pHead);
        ovLeave();
        ov->pHead = pNew;
      }
    }
    if( rc==SQLITE_OK ){
      memcpy(ov->pHead->a, ov->apPage[0]->a, ov->szChunk);
      ov->nHead = ov->szChunk;
    }
  }
  if( rc==SQLITE_OK ){
    ovEnter();
    for(k=0; k<ov->nDirty; k++){
      i64 i = ov->aiDirty[k];
      OvPage *p = i<ov->nPage ? ov->apPage[i] : 0;
      if( p==0 ) continue;
      if( --p->nRef==0 ) sqlite3_free(p);
      ov->apPage[i] = 0;
      ov->nUsed--;
    }
    ovLeave();
    ov->szVisible = ov->szStored = ov->szFile;
    ovResetDirty(ov);
  }
  ov->rcWrite = rc;
  /* The commit is stored either way: a failed checkpoint is tried again. */
  if( rc==SQLITE_OK && ov->iJournal>OV_JOURNAL_LIMIT ) ovCheckpoint(ov);
  return rc;
}

/*
** Replay the journal into the base file after it was not checkpointed:
** every complete record that follows the one before it, in order. Then
** sync the base file and start the journal over.
*/
static int ovRecover(Overlay *ov){
  static const u8 zero[OV_REDO_HEADER];
  sqlite3_file *pJ = ov->pJournal, *pB = ov->pBase;
  u8 head[OV_REDO_HEADER], trail[OV_REDO_TRAILER];
  u8 *a = 0;
  i64 szJournal = 0, off = 0;
  unsigned int salt = 0, seq = 0;
  int nApplied = 0, szAlloc = 0;
  int rc = pJ->pMethods->xFileSize(pJ, &szJournal);
  while( rc==SQLITE_OK && off+OV_REDO_HEADER+OV_REDO_TRAILER<=szJournal ){
    i64 nEntry, end, k, pos, szFile, szBase = 0;
    int szChunk, pass;
    unsigned int cksum = 0;
    rc = pJ->pMethods->xRead(pJ, head, OV_REDO_HEADER, off);
    if( rc!=SQLITE_OK || memcmp(head, "OVREDO02", 8)!=0 ) break;
    szChunk = (int)ovGet32(head+16);
    nEntry = ovGet32(head+20);
    szFile = ovGet64(head+24);
    if( szChunk<512 || szChunk>65536 || (szChunk & (szChunk-1))!=0
     || szFile<0 ){
      break;
    }
    if( nApplied>0 && (ovGet32(head+8)!=salt || ovGet32(head+12)!=seq+1) ){
      break;
    }
    end = off+OV_REDO_HEADER+nEntry*(8+szChunk)+OV_REDO_TRAILER;
    if( end>szJournal ) break;
    if( szAlloc<8+szChunk ){
      sqlite3_free(a);
      a = sqlite3_malloc(8+szChunk);
      if( a==0 ){
        rc = SQLITE_NOMEM;
        break;
      }
      szAlloc = 8+szChunk;
    }
    /* Check the whole record before writing any of it. */
    for(pass=0; rc==SQLITE_OK && pass<2; pass++){
      if( pass==0 ) cksum = ovChecksum(0, head, OV_REDO_HEADER);
      for(k=0, pos=off+OV_REDO_HEADER; rc==SQLITE_OK && k<nEntry;
          k++, pos+=8+szChunk){
        i64 i, n;
        rc = pJ->pMethods->xRead(pJ, a, 8+szChunk, pos);
        if( rc!=SQLITE_OK ) break;
        if( pass==0 ){
          cksum = ovChecksum(cksum, a, 8+szChunk);
          continue;
        }
        i = ovGet64(a);
        n = szFile - i*szChunk;
        if( n>szChunk ) n = szChunk;
        if( n>0 ) rc = pB->pMethods->xWrite(pB, a+8, (int)n, i*szChunk);
      }
      if( rc==SQLITE_OK && pass==0 ){
        rc = pJ->pMethods->xRead(pJ, trail, OV_REDO_TRAILER, pos);
        if( rc==SQLITE_OK
         && (ovGet32(trail)!=cksum || ovGet32(trail+4)!=(unsigned int)nEntry
          || memcmp(trail+8, "OVCOMMIT", 8)!=0) ){
          break;
        }
      }
    }
    if( rc!=SQLITE_OK || pass<2 ) break;
    rc = pB->pMethods->xFileSize(pB, &szBase);
    if( rc==SQLITE_OK && szBase>szFile ) rc = pB->pMethods->xTruncate(pB, szFile);
    salt = ovGet32(head+8);
    seq = ovGet32(head+12);
    nApplied++;
    off = end;
  }
  sqlite3_free(a);
  if( rc==SQLITE_OK && nApplied ) rc = pB->pMethods->xSync(pB, SQLITE_SYNC_NORMAL);
  if( rc==SQLITE_OK && szJournal>=OV_REDO_HEADER ){
    rc = pJ->pMethods->xWrite(pJ, zero, OV_REDO_HEADER, 0);
  }
  if( rc==SQLITE_OK ) ovNewJournal(ov);
  return rc;
}

/* ------------------------------------------------------------------------ */
/* Main database file methods                                               */
/* ------------------------------------------------------------------------ */

static int ovUnlock(sqlite3_file*, int);

static int ovClose(sqlite3_file *pFile){
  OvFile *p = (OvFile*)pFile;
  Overlay *ov = p->pOv;
  ovUnlock(pFile, SQLITE_LOCK_NONE);
  /* The last connection: store commits whose write-back failed, if that
  ** works now (outside gMutex, which ovWriteBack takes). */
  if( ov->pBaseVfs && ov->nRef==1 ) ovWriteBack(ov);
  ovEnter();
  if( --ov->nRef==0 ) ovDestroyLocked(ov);
  ovLeave();
  p->pOv = 0;
  return SQLITE_OK;
}

static int ovRead(sqlite3_file *pFile, void *zBuf, int iAmt, i64 iOfst){
  Overlay *ov = ((OvFile*)pFile)->pOv;
  u8 *out = (u8*)zBuf;
  int nValid, done = 0;

  if( iOfst>=ov->szFile ) nValid = 0;
  else if( iOfst+iAmt>ov->szFile ) nValid = (int)(ov->szFile-iOfst);
  else nValid = iAmt;

  while( done<nValid ){
    i64 off = iOfst+done;
    i64 i = off/ov->szChunk;
    int o = (int)(off%ov->szChunk);
    int n = ov->szChunk-o;
    OvPage *pg = i<ov->nPage ? ov->apPage[i] : 0;
    if( n>nValid-done ) n = nValid-done;
    if( pg ){
      memcpy(out+done, pg->a+o, n);
    }else{
      i64 nb = ov->szVisible-off;
      if( nb>n ) nb = n;
      if( nb<0 ) nb = 0;
      if( nb>0 ){
        int rc = ovBaseRead(ov, out+done, (int)nb, off);
        if( rc!=SQLITE_OK ) return rc;
      }
      if( nb<n ) memset(out+done+nb, 0, (size_t)(n-nb));
    }
    done += n;
  }
  if( nValid<iAmt ){
    memset(out+nValid, 0, iAmt-nValid);
    return SQLITE_IOERR_SHORT_READ;
  }
  return SQLITE_OK;
}

static int ovWriteChunks(Overlay *ov, const u8 *in, int iAmt, i64 iOfst){
  int done = 0;
  while( done<iAmt ){
    i64 off = iOfst+done;
    i64 i = off/ov->szChunk;
    int o = (int)(off%ov->szChunk);
    int n = ov->szChunk-o;
    OvPage *pg;
    int rc;
    if( n>iAmt-done ) n = iAmt-done;
    rc = ovPageForWrite(ov, i, o==0 && n==ov->szChunk, &pg);
    if( rc==SQLITE_OK ) rc = ovMarkDirty(ov, i);
    if( rc!=SQLITE_OK ) return rc==SQLITE_NOMEM ? SQLITE_IOERR_NOMEM : rc;
    memcpy(pg->a+o, in+done, n);
    done += n;
  }
  if( iOfst+iAmt>ov->szFile ) ov->szFile = iOfst+iAmt;
  return SQLITE_OK;
}

static int ovWrite(sqlite3_file *pFile, const void *zBuf, int iAmt, i64 iOfst){
  Overlay *ov = ((OvFile*)pFile)->pOv;
  /* The first write to an empty overlay starts with the header, which
  ** tells the page size. */
  if( ov->szFile==0 && ov->nUsed==0 && iOfst==0 && iAmt>=100 ){
    ovUsePageSize(ov, (const u8*)zBuf);
  }
  return ovWriteChunks(ov, (const u8*)zBuf, iAmt, iOfst);
}

static int ovTruncate(sqlite3_file *pFile, i64 size){
  Overlay *ov = ((OvFile*)pFile)->pOv;
  if( size<ov->szVisible ) ov->szVisible = size;
  if( size<ov->szMin ) ov->szMin = size;
  if( size<ov->szFile ){
    i64 nKeep = (size+ov->szChunk-1)/ov->szChunk;
    int iTail = (int)(size%ov->szChunk);
    ovEnter();
    ovDropPagesLocked(ov, nKeep);
    ovLeave();
    /* Bytes past the end must read as zero if the file grows again. */
    if( iTail && nKeep-1<ov->nPage && ov->apPage[nKeep-1] ){
      OvPage *pg;
      int rc = ovPageForWrite(ov, nKeep-1, 0, &pg);
      if( rc==SQLITE_OK ) rc = ovMarkDirty(ov, nKeep-1);
      if( rc!=SQLITE_OK ) return rc==SQLITE_NOMEM ? SQLITE_IOERR_NOMEM : rc;
      memset(pg->a+iTail, 0, ov->szChunk-iTail);
    }
  }
  ov->szFile = size;
  return SQLITE_OK;
}

static int ovSync(sqlite3_file *pFile, int flags){
  (void)pFile; (void)flags;
  return SQLITE_OK;
}

static int ovFileSize(sqlite3_file *pFile, i64 *pSize){
  *pSize = ((OvFile*)pFile)->pOv->szFile;
  return SQLITE_OK;
}

static int ovLock(sqlite3_file *pFile, int eLock){
  OvFile *p = (OvFile*)pFile;
  Overlay *ov = p->pOv;
  int rc = SQLITE_OK;
  if( p->eLock>=eLock ) return SQLITE_OK;
  ovEnter();
  switch( eLock ){
    case SQLITE_LOCK_SHARED:
      if( ov->eWriter>=SQLITE_LOCK_PENDING ){
        rc = SQLITE_BUSY;
      }else{
        ov->nShared++;
        p->eLock = SQLITE_LOCK_SHARED;
        /* Raising the mapping limit fails while pages are out. */
        if( p->szMmap>ov->szMmap ) ovMmapLimitLocked(ov, p->szMmap);
      }
      break;
    case SQLITE_LOCK_RESERVED:
      if( ov->pWriter && ov->pWriter!=p ){
        rc = SQLITE_BUSY;
      }else{
        ov->pWriter = p;
        ov->eWriter = p->eLock = SQLITE_LOCK_RESERVED;
      }
      break;
    default: /* SQLITE_LOCK_EXCLUSIVE */
      if( ov->pWriter && ov->pWriter!=p ){
        rc = SQLITE_BUSY;
      }else{
        ov->pWriter = p;
        if( ov->nShared>1 ){
          /* PENDING keeps new readers out while existing ones finish. */
          ov->eWriter = p->eLock = SQLITE_LOCK_PENDING;
          rc = SQLITE_BUSY;
        }else{
          ov->eWriter = p->eLock = SQLITE_LOCK_EXCLUSIVE;
        }
      }
      break;
  }
  ovLeave();
  return rc;
}

static int ovUnlock(sqlite3_file *pFile, int eLock){
  OvFile *p = (OvFile*)pFile;
  Overlay *ov = p->pOv;
  if( p->eLock<=eLock ) return SQLITE_OK;
  ovEnter();
  if( p->eLock>SQLITE_LOCK_SHARED && ov->pWriter==p ){
    ov->pWriter = 0;
    ov->eWriter = SQLITE_LOCK_NONE;
  }
  if( eLock==SQLITE_LOCK_NONE && p->eLock>=SQLITE_LOCK_SHARED ) ov->nShared--;
  p->eLock = eLock;
  ovLeave();
  return SQLITE_OK;
}

static int ovCheckReservedLock(sqlite3_file *pFile, int *pResOut){
  Overlay *ov = ((OvFile*)pFile)->pOv;
  ovEnter();
  *pResOut = ov->pWriter!=0;
  ovLeave();
  return SQLITE_OK;
}

static int ovFileControl(sqlite3_file *pFile, int op, void *pArg){
  Overlay *ov = ((OvFile*)pFile)->pOv;
  if( op==SQLITE_FCNTL_VFSNAME ){
    *(char**)pArg = sqlite3_mprintf("%s", OVERLAY_VFS_NAME);
    return SQLITE_OK;
  }
  if( op==SQLITE_FCNTL_COMMIT_PHASETWO ){
    /* Committed, and still holding the write lock. The commit stands even
    ** if the hook or the write-back failed: its changes are reported, or
    ** written, with the next one (or sqlite3_overlay_flush). */
    if( ov->pBaseVfs ) ovWriteBack(ov);
    else ovReportCommit(ov);
    return SQLITE_OK;
  }
  if( op==SQLITE_FCNTL_MMAP_SIZE ){
    /* PRAGMA mmap_size: map up to this connection's limit, and report the
    ** part of it the base file's mapping covers. */
    OvFile *p = (OvFile*)pFile;
    i64 sz = *(i64*)pArg;
    if( ov->pBase==0 || ov->pBase->pMethods->iVersion<3 ){
      return SQLITE_NOTFOUND;
    }
    ovEnter();
    if( sz>=0 ){
      p->szMmap = sz;
      ovMmapLimitLocked(ov, sz);
    }
    *(i64*)pArg = p->szMmap<ov->szMmap ? p->szMmap : ov->szMmap;
    ovLeave();
    return SQLITE_OK;
  }
  if( op==SQLITE_FCNTL_PRAGMA ){
    /* PRAGMA overlay_pages: pages held in memory by this overlay alone,
    ** that is, not shared with a fork or the overlay it was forked from. */
    char **azArg = (char**)pArg;
    if( sqlite3_stricmp(azArg[1], "overlay_pages")==0 ){
      i64 i, nOwned = 0;
      ovEnter();
      for(i=0; i<ov->nPage; i++){
        if( ov->apPage[i] && ov->apPage[i]->nRef==1 ) nOwned++;
      }
      ovLeave();
      azArg[0] = sqlite3_mprintf("%lld", nOwned);
      return SQLITE_OK;
    }
  }
  return SQLITE_NOTFOUND;
}

static int ovSectorSize(sqlite3_file *pFile){
  (void)pFile;
  return 4096;
}

static int ovDeviceCharacteristics(sqlite3_file *pFile){
  (void)pFile;
  return SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_POWERSAFE_OVERWRITE |
         SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_SEQUENTIAL;
}

/*
** Memory-map a page of the base file that the overlay has not changed, with
** PRAGMA mmap_size. The base file does not change while the overlay exists,
** so a mapped page stays valid. Other pages, and every page while this
** connection writes, are read with xRead. SQLite never maps page 1.
*/
static int ovFetch(sqlite3_file *pFile, i64 iOfst, int iAmt, void **pp){
  OvFile *p = (OvFile*)pFile;
  Overlay *ov = p->pOv;
  sqlite3_file *pBase = ov->pBase;
  i64 i = iOfst/ov->szChunk;
  int rc;
  *pp = 0;
  /* A writable base changes with every write-back: never map it. */
  if( pBase==0 || ov->bChanging || pBase->pMethods->iVersion<3
   || pBase->pMethods->xFetch==0
   || p->eLock>SQLITE_LOCK_SHARED
   || iOfst<ov->nHead || iOfst+iAmt>ov->szVisible || iOfst+iAmt>p->szMmap
   || iOfst%ov->szChunk+iAmt>ov->szChunk
   || (i<ov->nPage && ov->apPage[i]) ){
    return SQLITE_OK;
  }
  ovEnter();
  rc = pBase->pMethods->xFetch(pBase, iOfst, iAmt, pp);
  ovLeave();
  return rc;
}

static int ovUnfetch(sqlite3_file *pFile, i64 iOfst, void *pPage){
  Overlay *ov = ((OvFile*)pFile)->pOv;
  int rc;
  /* Without a page SQLite asks to drop a mapping that may be stale. The
  ** base file does not change, and other connections may use its pages. */
  if( pPage==0 ) return SQLITE_OK;
  ovEnter();
  rc = ov->pBase->pMethods->xUnfetch(ov->pBase, iOfst, pPage);
  ovLeave();
  return rc;
}

static const sqlite3_io_methods ovIoMethods = {
  3,                          /* iVersion: no shared memory, mmap */
  ovClose,
  ovRead,
  ovWrite,
  ovTruncate,
  ovSync,
  ovFileSize,
  ovLock,
  ovUnlock,
  ovCheckReservedLock,
  ovFileControl,
  ovSectorSize,
  ovDeviceCharacteristics,
  0, 0, 0, 0,                 /* xShmMap, xShmLock, xShmBarrier, xShmUnmap */
  ovFetch,
  ovUnfetch
};

/* ------------------------------------------------------------------------ */
/* In-memory journal and WAL files                                          */
/* ------------------------------------------------------------------------ */

static int memClose(sqlite3_file *pFile){
  MemFile *p = (MemFile*)pFile;
  sqlite3_free(p->a);
  p->a = 0;
  return SQLITE_OK;
}

static int memRead(sqlite3_file *pFile, void *zBuf, int iAmt, i64 iOfst){
  MemFile *p = (MemFile*)pFile;
  i64 n = p->sz-iOfst;
  if( n>iAmt ) n = iAmt;
  if( n<0 ) n = 0;
  if( n>0 ) memcpy(zBuf, p->a+iOfst, (size_t)n);
  if( n<iAmt ){
    memset((u8*)zBuf+n, 0, (size_t)(iAmt-n));
    return SQLITE_IOERR_SHORT_READ;
  }
  return SQLITE_OK;
}

static int memWrite(sqlite3_file *pFile, const void *zBuf, int iAmt, i64 iOfst){
  MemFile *p = (MemFile*)pFile;
  i64 end = iOfst+iAmt;
  if( end>p->nAlloc ){
    i64 nNew = p->nAlloc ? p->nAlloc*2 : 8192;
    u8 *a;
    while( nNew<end ) nNew *= 2;
    a = sqlite3_realloc64(p->a, nNew);
    if( a==0 ) return SQLITE_IOERR_NOMEM;
    p->a = a;
    p->nAlloc = nNew;
  }
  if( iOfst>p->sz ) memset(p->a+p->sz, 0, (size_t)(iOfst-p->sz));
  memcpy(p->a+iOfst, zBuf, iAmt);
  if( end>p->sz ) p->sz = end;
  return SQLITE_OK;
}

static int memTruncate(sqlite3_file *pFile, i64 size){
  MemFile *p = (MemFile*)pFile;
  if( size<p->sz ) p->sz = size;
  return SQLITE_OK;
}

static int memFileSize(sqlite3_file *pFile, i64 *pSize){
  *pSize = ((MemFile*)pFile)->sz;
  return SQLITE_OK;
}

static int memLock(sqlite3_file *pFile, int eLock){
  (void)pFile; (void)eLock;
  return SQLITE_OK;
}

static int memCheckReservedLock(sqlite3_file *pFile, int *pResOut){
  (void)pFile;
  *pResOut = 0;
  return SQLITE_OK;
}

static int memFileControl(sqlite3_file *pFile, int op, void *pArg){
  (void)pFile; (void)op; (void)pArg;
  return SQLITE_NOTFOUND;
}

static const sqlite3_io_methods memIoMethods = {
  1,
  memClose,
  memRead,
  memWrite,
  memTruncate,
  ovSync,
  memFileSize,
  memLock,
  memLock,
  memCheckReservedLock,
  memFileControl,
  ovSectorSize,
  ovDeviceCharacteristics,
  0, 0, 0, 0, 0, 0
};

/* ------------------------------------------------------------------------ */
/* VFS methods                                                              */
/* ------------------------------------------------------------------------ */

static int ovOpenMain(const char *zName, OvFile *pF, int flags, int *pOutFlags){
  const char *zOverlay = sqlite3_uri_parameter(zName, "overlay");
  const char *zFrom = sqlite3_uri_parameter(zName, "from");
  Overlay *ov = 0;
  int rc = SQLITE_OK;

  if( zOverlay && zOverlay[0]==0 ) zOverlay = 0;
  ovEnter();
  if( zOverlay ) ov = ovFind(zOverlay);
  if( ov ){
    if( zFrom ){
      sqlite3_log(SQLITE_CANTOPEN,
          "overlay: '%s' already exists, cannot create it from '%s'",
          zOverlay, zFrom);
      rc = SQLITE_CANTOPEN;
    }else if( !ovSameBase(ov, zName) ){
      sqlite3_log(SQLITE_CANTOPEN,
          "overlay: '%s' is open on a different base file", zOverlay);
      rc = SQLITE_CANTOPEN;
    }else{
      ov->nRef++;
    }
  }else{
    Overlay *pSrc = 0;
    if( zFrom ){
      pSrc = ovFind(zFrom);
      if( pSrc==0 ){
        sqlite3_log(SQLITE_CANTOPEN, "overlay: no open overlay '%s'", zFrom);
        rc = SQLITE_CANTOPEN;
      }else if( !ovSameBase(pSrc, zName) ){
        sqlite3_log(SQLITE_CANTOPEN,
            "overlay: '%s' is open on a different base file", zFrom);
        rc = SQLITE_CANTOPEN;
      }else if( pSrc->eWriter>=SQLITE_LOCK_PENDING ){
        /* Mid-commit: its pages are not a consistent snapshot right now. */
        rc = SQLITE_BUSY;
      }
    }
    if( rc==SQLITE_OK ) rc = ovCreateLocked(zName, zOverlay, pSrc, &ov);
  }
  ovLeave();

  if( rc==SQLITE_OK ){
    pF->pOv = ov;
    pF->base.pMethods = &ovIoMethods;
    if( pOutFlags ) *pOutFlags = flags;
  }
  return rc;
}

static int ovOpen(
  sqlite3_vfs *pVfs,
  const char *zName,
  sqlite3_file *pFile,
  int flags,
  int *pOutFlags
){
  (void)pVfs;
  if( (flags & SQLITE_OPEN_MAIN_DB) && zName ){
    memset(pFile, 0, sizeof(OvFile));
    return ovOpenMain(zName, (OvFile*)pFile, flags, pOutFlags);
  }
  if( flags & (SQLITE_OPEN_MAIN_JOURNAL|SQLITE_OPEN_WAL|SQLITE_OPEN_SUPER_JOURNAL) ){
    memset(pFile, 0, sizeof(MemFile));
    pFile->pMethods = &memIoMethods;
    if( pOutFlags ) *pOutFlags = flags;
    return SQLITE_OK;
  }
  /* Anonymous temp files (sorting, temp tables, statement journals). */
  return gOrig->xOpen(gOrig, zName, pFile, flags, pOutFlags);
}

/* Journal and WAL files only ever exist in memory, so nothing is deleted. */
static int ovDelete(sqlite3_vfs *pVfs, const char *zPath, int dirSync){
  (void)pVfs; (void)zPath; (void)dirSync;
  return SQLITE_OK;
}

static int ovHasSuffix(const char *z, const char *zSuffix){
  size_t n = strlen(z), m = strlen(zSuffix);
  return n>=m && memcmp(z+n-m, zSuffix, m)==0;
}

static int ovAccess(sqlite3_vfs *pVfs, const char *zPath, int flags, int *pResOut){
  (void)pVfs;
  /* Ignore journals on disk: the base is read as-is and ours are private. */
  if( ovHasSuffix(zPath, "-journal") || ovHasSuffix(zPath, "-wal")
   || ovHasSuffix(zPath, "-shm") ){
    *pResOut = 0;
    return SQLITE_OK;
  }
  return gOrig->xAccess(gOrig, zPath, flags, pResOut);
}

static int ovFullPathname(sqlite3_vfs *pVfs, const char *zPath, int nOut, char *zOut){
  (void)pVfs;
  return gOrig->xFullPathname(gOrig, zPath, nOut, zOut);
}

static void *ovDlOpen(sqlite3_vfs *pVfs, const char *zPath){
  (void)pVfs;
  return gOrig->xDlOpen ? gOrig->xDlOpen(gOrig, zPath) : 0;
}

static void ovDlError(sqlite3_vfs *pVfs, int nByte, char *zErrMsg){
  (void)pVfs;
  if( gOrig->xDlError ) gOrig->xDlError(gOrig, nByte, zErrMsg);
}

static void (*ovDlSym(sqlite3_vfs *pVfs, void *p, const char *zSym))(void){
  (void)pVfs;
  return gOrig->xDlSym ? gOrig->xDlSym(gOrig, p, zSym) : 0;
}

static void ovDlClose(sqlite3_vfs *pVfs, void *p){
  (void)pVfs;
  if( gOrig->xDlClose ) gOrig->xDlClose(gOrig, p);
}

static int ovRandomness(sqlite3_vfs *pVfs, int nByte, char *zOut){
  (void)pVfs;
  return gOrig->xRandomness(gOrig, nByte, zOut);
}

static int ovSleep(sqlite3_vfs *pVfs, int nMicro){
  (void)pVfs;
  return gOrig->xSleep(gOrig, nMicro);
}

static int ovCurrentTime(sqlite3_vfs *pVfs, double *pTime){
  (void)pVfs;
  return gOrig->xCurrentTime(gOrig, pTime);
}

static int ovGetLastError(sqlite3_vfs *pVfs, int n, char *z){
  (void)pVfs;
  return gOrig->xGetLastError ? gOrig->xGetLastError(gOrig, n, z) : 0;
}

static int ovCurrentTimeInt64(sqlite3_vfs *pVfs, i64 *pTime){
  double r;
  int rc;
  (void)pVfs;
  if( gOrig->iVersion>=2 && gOrig->xCurrentTimeInt64 ){
    return gOrig->xCurrentTimeInt64(gOrig, pTime);
  }
  rc = gOrig->xCurrentTime(gOrig, &r);
  *pTime = (i64)(r*86400000.0);
  return rc;
}

static sqlite3_vfs ovVfs = {
  2,                          /* iVersion */
  0,                          /* szOsFile, set on register */
  0,                          /* mxPathname, set on register */
  0,                          /* pNext */
  OVERLAY_VFS_NAME,           /* zName */
  0,                          /* pAppData */
  ovOpen,
  ovDelete,
  ovAccess,
  ovFullPathname,
  ovDlOpen,
  ovDlError,
  ovDlSym,
  ovDlClose,
  ovRandomness,
  ovSleep,
  ovCurrentTime,
  ovGetLastError,
  ovCurrentTimeInt64,
  0, 0, 0
};

/*
** Append part of a database image to an empty overlay, in order from offset
** 0. Overlays without a base file (see OVERLAY_OMIT_BASE) are populated this
** way before first use. The first part sets the chunk size: szChunk, or the
** page size in the header if szChunk is 0. Loading an image with the chunk
** size it was stored with keeps chunk indexes stable across reloads, also
** after VACUUM changed the page size.
*/
int sqlite3_overlay_load(
  sqlite3 *db,
  const char *zSchema,
  const void *pData,
  int nData,
  sqlite3_int64 iOfst,
  int szChunk
){
  sqlite3_file *pFile = 0;
  Overlay *ov;
  int rc;
  sqlite3_file_control(db, zSchema, SQLITE_FCNTL_FILE_POINTER, &pFile);
  if( pFile==0 || pFile->pMethods!=&ovIoMethods ) return SQLITE_MISUSE;
  ov = ((OvFile*)pFile)->pOv;
  if( iOfst!=ov->szFile || (iOfst==0 && ov->nUsed>0) ) return SQLITE_MISUSE;
  if( iOfst==0 ){
    if( szChunk==0 ){
      if( nData>=100 ) ovUsePageSize(ov, pData);
    }else if( szChunk>=512 && szChunk<=65536 && (szChunk & (szChunk-1))==0 ){
      ov->szChunk = szChunk;
    }else{
      return SQLITE_MISUSE;
    }
  }
  rc = ovWriteChunks(ov, pData, nData, iOfst);
  if( rc==SQLITE_OK && iOfst==0 && nData>=100 && ovIsWalHeader(pData) ){
    ovPatchWal(ov->apPage[0]->a, 20, 0);
  }
  return rc;
}

/*
** Call xCommit(pArg, pCommit) after every commit that changes the overlay
** behind zSchema, with the chunks written since the previous commit; their
** content is valid for the duration of the call. xCommit runs inside the
** commit and must not use the database connection. If it returns anything
** but SQLITE_OK, its changes are reported again with the next commit.
** Changes made before registering are not reported; register while no
** transaction is open. A NULL xCommit removes the hook. The current chunk
** size is written to *pszChunk; it only changes when the overlay is emptied
** and refilled with a different page size, which is then reported with
** szMin 0.
*/
int sqlite3_overlay_commit_hook(
  sqlite3 *db,
  const char *zSchema,
  sqlite3_overlay_hook xCommit,
  void *pArg,
  int *pszChunk
){
  sqlite3_file *pFile = 0;
  Overlay *ov;
  sqlite3_file_control(db, zSchema, SQLITE_FCNTL_FILE_POINTER, &pFile);
  if( pFile==0 || pFile->pMethods!=&ovIoMethods ) return SQLITE_MISUSE;
  ov = ((OvFile*)pFile)->pOv;
  if( xCommit && ov->pBaseVfs ) return SQLITE_MISUSE;
  if( xCommit ){
    /* A snapshot of a stored database is stored elsewhere: it no longer
    ** reads from that file. */
    int rc = ovUnborrow(ov);
    if( rc!=SQLITE_OK ) return rc;
  }
  ovResetDirty(ov);
  ov->xCommit = xCommit;
  ov->pCommitArg = pArg;
  if( pszChunk ) *pszChunk = ov->szChunk;
  return SQLITE_OK;
}

/*
** Report the whole committed file behind zSchema to its commit hook, as one
** commit that replaces everything (szMin 0) and writes every chunk the
** overlay holds; the chunks it does not hold read as zero. Use it to store
** an overlay somewhere new. Only for overlays without a base file, which
** hold every chunk that is not zero (SQLITE_MISUSE otherwise). Fails with
** SQLITE_BUSY during a write transaction. Returns the error of the hook if
** it failed; the file is then reported again with the next commit.
*/
int sqlite3_overlay_report_all(sqlite3 *db, const char *zSchema){
  sqlite3_file *pFile = 0;
  Overlay *ov;
  i64 i, nChunk;
  int rc;
  sqlite3_file_control(db, zSchema, SQLITE_FCNTL_FILE_POINTER, &pFile);
  if( pFile==0 || pFile->pMethods!=&ovIoMethods ) return SQLITE_MISUSE;
  ov = ((OvFile*)pFile)->pOv;
  if( ov->xCommit==0 || ov->pBase ) return SQLITE_MISUSE;
  if( ov->pWriter ) return SQLITE_BUSY;
  nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  for(i=0; i<nChunk && i<ov->nPage; i++){
    if( ov->apPage[i] && (rc = ovMarkDirty(ov, i))!=SQLITE_OK ) return rc;
  }
  ov->szMin = 0;
  /* Report even an empty file, which still replaces the stored one. */
  ov->szCommitted = -1;
  return ovReportCommit(ov);
}

/* The overlay behind zSchema, or NULL if it is not an overlay. */
static Overlay *ovOf(sqlite3 *db, const char *zSchema){
  sqlite3_file *pFile = 0;
  sqlite3_file_control(db, zSchema, SQLITE_FCNTL_FILE_POINTER, &pFile);
  if( pFile==0 || pFile->pMethods!=&ovIoMethods ) return 0;
  return ((OvFile*)pFile)->pOv;
}

/*
** Store the overlay behind zSchema, which has no base file, in the file
** zPath of VFS zVfs from now on, as if it had been opened with base=zVfs:
** its committed state replaces what the file held, written as one
** write-back (so the file holds either), after which every commit is
** written back to it and the overlay drops its stored chunks from memory.
** SQLITE_MISUSE for overlays with a base file or a commit hook, SQLITE_BUSY
** during a write transaction. On failure the overlay is left as it was.
*/
int sqlite3_overlay_attach_base(
  sqlite3 *db,
  const char *zSchema,
  const char *zVfs,
  const char *zPath
){
  Overlay *ov = ovOf(db, zSchema);
  sqlite3_vfs *pVfs = zVfs ? sqlite3_vfs_find(zVfs) : 0;
  i64 i, nChunk, szBase = 0;
  int rc;
  if( ov==0 || ov->pBaseVfs || ov->xCommit ) return SQLITE_MISUSE;
  if( pVfs==0 || strcmp(zVfs, OVERLAY_VFS_NAME)==0 ) return SQLITE_CANTOPEN;
  if( ov->pWriter ) return SQLITE_BUSY;
  /* A snapshot of a stored database first copies what it reads from it. */
  rc = ovUnborrow(ov);
  if( rc!=SQLITE_OK ) return rc;
  if( ov->pBase ) return SQLITE_MISUSE;
  /* Fill holes with zero chunks first: once there is a base file, missing
  ** chunks would be read from it. */
  nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  for(i=0; i<nChunk; i++){
    OvPage *pg;
    if( i<ov->nPage && ov->apPage[i] ) continue;
    rc = ovPageForWrite(ov, i, 1, &pg);
    if( rc!=SQLITE_OK ) return rc;
    memset(pg->a, 0, ov->szChunk);
  }
  ov->szVisible = 0;
  rc = ovOpenWritableBase(ov, pVfs, zPath, &szBase);
  if( rc==SQLITE_OK ){
    ov->bChanging = 1;
    ov->szStored = szBase;
    ovResetDirty(ov);
    for(i=0; rc==SQLITE_OK && i<nChunk; i++) rc = ovMarkDirty(ov, i);
  }
  if( rc==SQLITE_OK ) rc = ovWriteBack(ov);
  if( rc!=SQLITE_OK ){
    ovCloseBase(ov);
    ovResetDirty(ov);
    ov->szVisible = 0;
  }
  return rc;
}

/*
** Stop writing the overlay behind zSchema to its writable base file, and
** keep it in memory from now on: first store the commits that are not
** stored yet, then read every chunk it does not hold from the base file,
** and close that. Snapshots that read the file copy what they read too.
** Fails, staying as it was, if reading fails (SQLITE_NOMEM or an I/O
** error), with SQLITE_MISUSE for overlays without a writable base and with
** SQLITE_BUSY during a write transaction. Otherwise it detaches, and the
** error of storing those commits, if that failed, is written to *pWrite;
** the overlay holds them either way.
*/
int sqlite3_overlay_detach_base(sqlite3 *db, const char *zSchema, int *pWrite){
  Overlay *ov = ovOf(db, zSchema);
  i64 i, nChunk;
  int rcWrite, rc = SQLITE_OK;
  if( ov==0 || ov->pBaseVfs==0 ) return SQLITE_MISUSE;
  if( ov->pWriter ) return SQLITE_BUSY;
  rcWrite = ovWriteBack(ov);
  nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  for(i=0; rc==SQLITE_OK && i<nChunk; i++) rc = ovPreserveChunk(ov, i);
  ovEnter();
  if( rc==SQLITE_OK ) rc = ovPreserveLocked(ov, 0, 1);
  if( rc==SQLITE_OK ) ovReleaseBorrowersLocked(ov);
  ovLeave();
  if( rc!=SQLITE_OK ) return rc;
  ovCheckpoint(ov);
  ovCloseBase(ov);
  ovResetDirty(ov);
  ov->szVisible = 0;
  if( pWrite ) *pWrite = rcWrite;
  return SQLITE_OK;
}

/*
** Write what is not stored yet to the writable base file behind zSchema:
** commits whose write-back failed. Returns the error if it fails again, and
** SQLITE_OK for overlays without a writable base. During a write
** transaction nothing is written: it returns the last write-back's result.
*/
int sqlite3_overlay_flush(sqlite3 *db, const char *zSchema){
  sqlite3_file *pFile = 0;
  Overlay *ov;
  sqlite3_file_control(db, zSchema, SQLITE_FCNTL_FILE_POINTER, &pFile);
  if( pFile==0 || pFile->pMethods!=&ovIoMethods ) return SQLITE_MISUSE;
  ov = ((OvFile*)pFile)->pOv;
  if( ov->pBaseVfs==0 ) return SQLITE_OK;
  if( ov->pWriter ) return ov->rcWrite;
  return ovWriteBack(ov);
}

/* ------------------------------------------------------------------------ */
/* Read-only base files of another VFS                                      */
/* ------------------------------------------------------------------------ */
/*
** With base=VFS&base_readonly=1, the base file is opened read-only through
** VFS, as the OS VFS opens it without base=: it is never written, and every
** change stays in the overlay. Snapshots (from=) open the same file with
** their own handle. The Wasm build stores databases this way in immutable
** base files that a checkpoint writes from time to time: it lists the pages
** an overlay holds (sqlite3_overlay_pages), writes a new base file with
** them, and moves the overlay onto it (sqlite3_overlay_rebase).
*/

/*
** Describe the pages the overlay behind zSchema holds over its base file,
** in *pPages: the index and content of each, the chunk size, the file size
** (szFile) and the part of the base file it still reads (szMin). Chunks it
** does not hold read from the base file below szMin, and as zero from
** there on; with this, the base file and the pages make up the database.
** Release the arrays with sqlite3_free((void*)pPages->aiChunk). The
** content stays valid until the overlay changes or closes. SQLITE_BUSY
** during a write transaction, SQLITE_MISUSE on a writable base file.
*/
int sqlite3_overlay_pages(
  sqlite3 *db,
  const char *zSchema,
  sqlite3_overlay_commit *pPages
){
  Overlay *ov = ovOf(db, zSchema);
  i64 i, nChunk, nHeld = 0;
  i64 *ai = 0;
  const u8 **ap = 0;
  memset(pPages, 0, sizeof(*pPages));
  /* A writable base changes: the pages alone do not describe the file. */
  if( ov==0 || ov->pBaseVfs || ov->bBorrowed ) return SQLITE_MISUSE;
  if( ov->pWriter ) return SQLITE_BUSY;
  nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  for(i=0; i<nChunk && i<ov->nPage; i++){
    if( ov->apPage[i] ) nHeld++;
  }
  if( nHeld>0 ){
    ai = sqlite3_malloc64(nHeld*(sizeof(i64)+sizeof(u8*)));
    if( ai==0 ) return SQLITE_NOMEM;
    ap = (const u8**)&ai[nHeld];
    for(i=0; i<nChunk && i<ov->nPage; i++){
      if( ov->apPage[i]==0 ) continue;
      ai[pPages->nChunk] = i;
      ap[pPages->nChunk] = ov->apPage[i]->a;
      pPages->nChunk++;
    }
  }
  pPages->szChunk = ov->szChunk;
  pPages->aiChunk = ai;
  pPages->apChunk = ap;
  pPages->szFile = ov->szFile;
  pPages->szMin = ov->szVisible<ov->szFile ? ov->szVisible : ov->szFile;
  return SQLITE_OK;
}

/*
** Move the overlay behind zSchema onto a new read-only base file, zPath of
** VFS zVfs, which holds the committed state of pSnapshot: a snapshot (from=)
** of this overlay on the same base file, whose base file and pages
** (sqlite3_overlay_pages) were written there. The overlay drops the pages
** it shares with the snapshot, which the new base holds, and keeps those
** that changed since; it reads exactly what it read before. Its old base
** file is closed. Allowed during a transaction, also one that wrote pages
** already, as the content does not change; not with PRAGMA mmap_size
** (SQLITE_MISUSE), nor for overlays on a writable base or with a commit
** hook. SQLITE_CORRUPT if the new base is not the snapshot's size. On failure the overlay reads its old base,
** possibly holding more pages than before.
**
** The caller makes sure no other connection uses the overlay meanwhile,
** and that its own connection is not in a call (between two calls of a
** single-threaded program).
*/
int sqlite3_overlay_rebase(
  sqlite3 *db,
  const char *zSchema,
  sqlite3 *pSnapshot,
  const char *zSnapshotSchema,
  const char *zVfs,
  const char *zPath
){
  Overlay *ov = ovOf(db, zSchema);
  Overlay *snap = pSnapshot ? ovOf(pSnapshot, zSnapshotSchema) : 0;
  sqlite3_vfs *pVfs = zVfs ? sqlite3_vfs_find(zVfs) : 0;
  Overlay base;
  i64 i, nChunk, szBase = 0, szNew;
  int rc;
  if( ov==0 || snap==0 || ov==snap ) return SQLITE_MISUSE;
  if( ov->pBaseVfs || ov->bBorrowed || ov->xCommit || ov->szMmap>0 ){
    return SQLITE_MISUSE;
  }
  /* The snapshot must read the same base file as the overlay. */
  if( snap->szChunk!=ov->szChunk || (ov->zPath==0)!=(snap->zPath==0)
   || (ov->zPath && strcmp(ov->zPath, snap->zPath)!=0) ){
    return SQLITE_MISUSE;
  }
  if( pVfs==0 || strcmp(zVfs, OVERLAY_VFS_NAME)==0 ) return SQLITE_CANTOPEN;

  /* Open the new base and read its first chunk, without touching ov. */
  memset(&base, 0, sizeof(base));
  base.szChunk = ov->szChunk;
  rc = ovOpenBase(&base, pVfs, zPath, 0, &szBase);
  if( rc==SQLITE_OK && szBase!=snap->szFile ) rc = SQLITE_CORRUPT;
  if( rc==SQLITE_OK && szBase>0 ){
    int n = szBase<base.szChunk ? (int)szBase : base.szChunk;
    base.pHead = ovPageAlloc(base.szChunk);
    if( base.pHead==0 ){
      rc = SQLITE_NOMEM;
    }else{
      rc = base.pBase->pMethods->xRead(base.pBase, base.pHead->a, n, 0);
      if( rc==SQLITE_IOERR_SHORT_READ ) rc = SQLITE_OK;
      if( n<base.szChunk ) memset(base.pHead->a+n, 0, base.szChunk-n);
      if( n>=100 && ovIsWalHeader(base.pHead->a) ){
        ovPatchWal(base.pHead->a, 20, 0);
      }
      base.nHead = base.szChunk;
    }
  }

  /* Bytes the overlay reads from its base below szNew from now on, and as
  ** zero past it: never past its own end, so the file grows with zeros. A
  ** chunk it does not hold must read the same from either base, or it gets
  ** a copy of what it reads now: chunks the snapshot holds (the overlay
  ** truncated them away since), and chunks that read from the old base in
  ** one and as zero in the other. */
  szNew = snap->szFile<ov->szFile ? snap->szFile : ov->szFile;
  nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  for(i=0; rc==SQLITE_OK && i<nChunk; i++){
    i64 iOfst = i*ov->szChunk;
    OvPage *pg;
    if( i<ov->nPage && ov->apPage[i] ) continue;
    if( iOfst>=szNew ){
      if( iOfst>=ov->szVisible ) continue;
    }else if( !(i<snap->nPage && snap->apPage[i])
           && (iOfst<snap->szVisible)==(iOfst<ov->szVisible) ){
      continue;
    }
    rc = ovPageForWrite(ov, i, 0, &pg);
  }
  if( rc!=SQLITE_OK ){
    if( base.pHead ) sqlite3_free(base.pHead);
    ovCloseBase(&base);
    return rc;
  }

  /* Drop the whole chunks the snapshot shares, which the new base holds. */
  ovEnter();
  for(i=0; i<ov->nPage && i<snap->nPage; i++){
    OvPage *p = ov->apPage[i];
    if( p==0 || p!=snap->apPage[i] || (i+1)*ov->szChunk>szNew ) continue;
    if( --p->nRef==0 ) sqlite3_free(p);
    ov->apPage[i] = 0;
    ov->nUsed--;
  }
  if( ov->pHead && --ov->pHead->nRef==0 ) sqlite3_free(ov->pHead);
  ovLeave();
  ovCloseBase(ov);
  ov->pBase = base.pBase;
  ov->zPath = base.zPath;
  ov->szMmap = base.szMmap;
  ov->pHead = base.pHead;
  ov->nHead = base.nHead;
  ov->pRoVfs = pVfs;
  ov->szVisible = szNew;
  ov->szStored = szBase;
  return SQLITE_OK;
}

/*
** Register the "overlay" VFS on top of the current default VFS. Safe to call
** more than once. Used directly when this file is compiled into SQLite.
*/
int sqlite3_overlay_register(int makeDefault){
  int sz;
  if( sqlite3_vfs_find(OVERLAY_VFS_NAME) ) return SQLITE_OK;
  gOrig = sqlite3_vfs_find(0);
  if( gOrig==0 ) return SQLITE_ERROR;
#if !defined(SQLITE_THREADSAFE) || SQLITE_THREADSAFE!=0
  gMutex = sqlite3_mutex_alloc(SQLITE_MUTEX_FAST);
#endif
  sz = gOrig->szOsFile;
  if( sz<(int)sizeof(OvFile) ) sz = (int)sizeof(OvFile);
  if( sz<(int)sizeof(MemFile) ) sz = (int)sizeof(MemFile);
  ovVfs.szOsFile = sz;
  ovVfs.mxPathname = gOrig->mxPathname;
  return sqlite3_vfs_register(&ovVfs, makeDefault);
}

#ifndef SQLITE_CORE
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_overlay_init(
  sqlite3 *db,
  char **pzErrMsg,
  const sqlite3_api_routines *pApi
){
  int rc;
  SQLITE_EXTENSION_INIT2(pApi);
  (void)db;
  rc = sqlite3_overlay_register(0);
  if( rc!=SQLITE_OK ){
    if( pzErrMsg ) *pzErrMsg = sqlite3_mprintf("overlay: cannot register VFS");
    return rc;
  }
  /* The VFS outlives the connection that loaded it. */
  return SQLITE_OK_LOAD_PERMANENTLY;
}
#endif
