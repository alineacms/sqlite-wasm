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

/* Free an overlay whose last connection has closed. Caller holds gMutex. */
static void ovDestroyLocked(Overlay *ov){
  /* Its base file may change or go away from now on: snapshots of it
  ** that still read from the base copy what they read. */
  if( ov->pBaseVfs ) ovPreserveLocked(ov, 0, 1);
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
  if( ov->pBase ){
    if( ov->pBase->pMethods ) ov->pBase->pMethods->xClose(ov->pBase);
    sqlite3_free(ov->pBase);
  }
  if( ov->pJournal ){
    if( ov->pJournal->pMethods ) ov->pJournal->pMethods->xClose(ov->pJournal);
    sqlite3_free(ov->pJournal);
  }
  sqlite3_free(ov->zJournal);
  if( ov->zPath ) sqlite3_free_filename((char*)ov->zPath);
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
    }else{
      rc = ovOpenWritableBase(ov, pVfs, zPath, &szBase);
      ov->bChanging = 1;
    }
  }else if( pSrc && pSrc->pBaseVfs ){
    /* A snapshot of an overlay on a writable base reads the same file;
    ** the source keeps what it reads from changing (ovPreserveLocked). */
    rc = ovOpenBase(ov, pSrc->pBaseVfs, pSrc->zPath, 0, &szBase);
    ov->bChanging = 1;
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
** A write-back first writes the chunks to a redo journal next to the base
** file (its name plus "-journal") and syncs it, then writes them to the
** base, syncs that and clears the journal's header. Opening the base
** replays a complete record, so the base always holds a committed state:
**
**   header   "OVREDO01", chunk size (4), chunk count (4), file size (8),
**            8 bytes reserved
**   entries  chunk index (8) and chunk content, per chunk
**   trailer  checksum (4), chunk count (4), "OVCOMMIT"
**
** Integers are big-endian; the checksum covers the header and entries.
**
** Snapshots (from=) of an overlay on a writable base read the same file.
** Before a chunk they still read from it changes, they get a private copy
** of it, so they keep their point-in-time view; when the writable overlay
** closes, they copy every chunk they read from the base. Only named
** overlays are found this way, as every overlay with from= is.
*/

#define OV_REDO_HEADER 32
#define OV_REDO_TRAILER 16

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
    if( o==ov || o->pBaseVfs || o->pBase==0 || o->zPath==0
     || strcmp(o->zPath, ov->zPath)!=0 ){
      continue;
    }
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

/* Write a whole redo journal record, as described above. */
static int ovWriteJournal(Overlay *ov, i64 nChunk, int *pnEntry){
  sqlite3_file *pJ = ov->pJournal;
  u8 head[OV_REDO_HEADER], trail[OV_REDO_TRAILER], idx[8];
  unsigned int cksum;
  i64 k, off = OV_REDO_HEADER;
  int nEntry = 0, rc;
  for(k=0; k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    if( i<nChunk && i<ov->nPage && ov->apPage[i] ) nEntry++;
  }
  memcpy(head, "OVREDO01", 8);
  ovPut32(head+8, (unsigned int)ov->szChunk);
  ovPut32(head+12, (unsigned int)nEntry);
  ovPut64(head+16, ov->szFile);
  memset(head+24, 0, 8);
  rc = pJ->pMethods->xWrite(pJ, head, OV_REDO_HEADER, 0);
  cksum = ovChecksum(0, head, OV_REDO_HEADER);
  for(k=0; rc==SQLITE_OK && k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    const u8 *a;
    if( i>=nChunk || i>=ov->nPage || ov->apPage[i]==0 ) continue;
    a = ov->apPage[i]->a;
    ovPut64(idx, i);
    rc = pJ->pMethods->xWrite(pJ, idx, 8, off);
    if( rc==SQLITE_OK ) rc = pJ->pMethods->xWrite(pJ, a, ov->szChunk, off+8);
    cksum = ovChecksum(ovChecksum(cksum, idx, 8), a, ov->szChunk);
    off += 8+ov->szChunk;
  }
  ovPut32(trail, cksum);
  ovPut32(trail+4, (unsigned int)nEntry);
  memcpy(trail+8, "OVCOMMIT", 8);
  if( rc==SQLITE_OK ) rc = pJ->pMethods->xWrite(pJ, trail, OV_REDO_TRAILER, off);
  if( rc==SQLITE_OK ) rc = pJ->pMethods->xSync(pJ, SQLITE_SYNC_NORMAL);
  *pnEntry = nEntry;
  return rc;
}

/*
** Mark the redo journal as done by clearing its header, which is cheaper
** than truncating it (as PRAGMA journal_mode=PERSIST does). Bytes after
** the header are ignored: a record is only complete if its length, chunk
** count and checksum add up. If clearing is lost, replaying the record
** again does no harm.
*/
static void ovEndJournal(Overlay *ov){
  static const u8 zero[OV_REDO_HEADER];
  ov->pJournal->pMethods->xWrite(ov->pJournal, zero, OV_REDO_HEADER, 0);
}

/* Set the base file's size to szFile, and sync it. */
static int ovFinishBase(Overlay *ov, i64 szFile){
  sqlite3_file *pB = ov->pBase;
  i64 szBase = 0;
  int rc = pB->pMethods->xFileSize(pB, &szBase);
  if( rc==SQLITE_OK && szBase>szFile ) rc = pB->pMethods->xTruncate(pB, szFile);
  if( rc==SQLITE_OK ) rc = pB->pMethods->xSync(pB, SQLITE_SYNC_NORMAL);
  return rc;
}

/*
** Store everything committed since the last write-back in the base file,
** through the redo journal, and drop the stored chunks from memory. On
** failure everything stays in memory and is written with the next commit.
*/
static int ovWriteBack(Overlay *ov){
  sqlite3_file *pB = ov->pBase;
  i64 nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  i64 k;
  int nEntry = 0;
  int rc;
  if( ov->nDirty==0 && ov->szFile==ov->szStored ) return ov->rcWrite = SQLITE_OK;
  ovEnter();
  /* Chunks past the end change only if the base file shrinks. */
  rc = ovPreserveLocked(ov, ov->szFile<ov->szStored
      ? ov->szFile/ov->szChunk : ((i64)1)<<62, 0);
  ovLeave();
  if( rc==SQLITE_OK ) rc = ovWriteJournal(ov, nChunk, &nEntry);
  for(k=0; rc==SQLITE_OK && k<ov->nDirty; k++){
    i64 i = ov->aiDirty[k];
    i64 n = ov->szFile - i*ov->szChunk;
    if( i>=nChunk || i>=ov->nPage || ov->apPage[i]==0 ) continue;
    if( n>ov->szChunk ) n = ov->szChunk;
    rc = pB->pMethods->xWrite(pB, ov->apPage[i]->a, (int)n, i*ov->szChunk);
  }
  if( rc==SQLITE_OK ) rc = ovFinishBase(ov, ov->szFile);
  if( rc==SQLITE_OK ) ovEndJournal(ov);
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
  return ov->rcWrite = rc;
}

/*
** Finish a write-back that was interrupted: replay a complete redo
** journal record into the base file, and discard an incomplete one.
*/
static int ovRecover(Overlay *ov){
  sqlite3_file *pJ = ov->pJournal, *pB = ov->pBase;
  u8 head[OV_REDO_HEADER], trail[OV_REDO_TRAILER];
  u8 *a = 0;
  i64 szJournal = 0, szFile, off, k, nEntry;
  int szChunk, pass;
  unsigned int cksum = 0;
  int rc = pJ->pMethods->xFileSize(pJ, &szJournal);
  if( rc!=SQLITE_OK || szJournal<OV_REDO_HEADER+OV_REDO_TRAILER ) return rc;
  rc = pJ->pMethods->xRead(pJ, head, OV_REDO_HEADER, 0);
  if( rc!=SQLITE_OK ) return rc;
  if( memcmp(head, "OVREDO01", 8)!=0 ) return SQLITE_OK;
  szChunk = (int)ovGet32(head+8);
  nEntry = ovGet32(head+12);
  szFile = ovGet64(head+16);
  if( memcmp(head, "OVREDO01", 8)!=0 || szChunk<512 || szChunk>65536
   || (szChunk & (szChunk-1))!=0 || szFile<0
   || szJournal<OV_REDO_HEADER+nEntry*(8+szChunk)+OV_REDO_TRAILER ){
    goto discard;
  }
  a = sqlite3_malloc(8+szChunk);
  if( a==0 ) return SQLITE_NOMEM;
  /* Check the whole record before writing anything. */
  for(pass=0; pass<2; pass++){
    if( pass==0 ) cksum = ovChecksum(0, head, OV_REDO_HEADER);
    for(k=0, off=OV_REDO_HEADER; k<nEntry; k++, off+=8+szChunk){
      i64 i, n;
      rc = pJ->pMethods->xRead(pJ, a, 8+szChunk, off);
      if( rc!=SQLITE_OK ) goto done;
      if( pass==0 ){
        cksum = ovChecksum(cksum, a, 8+szChunk);
        continue;
      }
      i = ovGet64(a);
      n = szFile - i*szChunk;
      if( n>szChunk ) n = szChunk;
      if( n>0 ) rc = pB->pMethods->xWrite(pB, a+8, (int)n, i*szChunk);
      if( rc!=SQLITE_OK ) goto done;
    }
    if( pass==0 ){
      rc = pJ->pMethods->xRead(pJ, trail, OV_REDO_TRAILER, off);
      if( rc!=SQLITE_OK ) goto done;
      if( ovGet32(trail)!=cksum || ovGet32(trail+4)!=(unsigned int)nEntry
       || memcmp(trail+8, "OVCOMMIT", 8)!=0 ){
        sqlite3_free(a);
        goto discard;
      }
    }
  }
  rc = ovFinishBase(ov, szFile);
done:
  sqlite3_free(a);
  if( rc!=SQLITE_OK ) return rc;
discard:
  ovEndJournal(ov);
  return SQLITE_OK;
}


/* ------------------------------------------------------------------------ */
/* Main database file methods                                               */
/* ------------------------------------------------------------------------ */

static int ovUnlock(sqlite3_file*, int);

static int ovClose(sqlite3_file *pFile){
  OvFile *p = (OvFile*)pFile;
  Overlay *ov = p->pOv;
  ovUnlock(pFile, SQLITE_LOCK_NONE);
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
