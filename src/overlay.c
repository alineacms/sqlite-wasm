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
** last connection closes, its changes are discarded.
**
** Locking
** -------
** Connections sharing a named overlay are coordinated with in-process
** SHARED/RESERVED/PENDING/EXCLUSIVE locks (the same protocol the OS VFSes
** implement with file locks). A SHARED lock is held on the base file for as
** long as an overlay exists, so other SQLite connections cannot modify it.
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
  int bPatchWal;          /* Base header says WAL: report rollback mode */
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
};

/* An open main database file. */
struct OvFile {
  sqlite3_file base;
  Overlay *pOv;
  int eLock;
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

/* Read from the base file. Bytes past its end read as zero. */
static int ovBaseRead(Overlay *ov, u8 *buf, int n, i64 off){
  int rc = ov->pBase->pMethods->xRead(ov->pBase, buf, n, off);
  if( rc==SQLITE_IOERR_SHORT_READ ) rc = SQLITE_OK;
  if( rc==SQLITE_OK && ov->bPatchWal && off<20 && off+n>18 ){
    ovPatchWal(buf, n, off);
  }
  return rc;
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
  if( ov->xCommit==0 ) return SQLITE_OK;
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
*/
static void ovReportCommit(Overlay *ov){
  sqlite3_overlay_commit c;
  i64 nChunk = (ov->szFile+ov->szChunk-1)/ov->szChunk;
  i64 *ai = 0;
  const u8 **ap = 0;
  i64 k;
  int rc;
  if( ov->xCommit==0 ) return;
  if( ov->nDirty==0 && ov->szFile==ov->szCommitted
   && ov->szMin==ov->szCommitted ){
    return;
  }
  if( ov->nDirty ){
    ai = sqlite3_malloc64(ov->nDirty*(sizeof(i64)+sizeof(u8*)));
    /* Out of memory: the changes are reported with the next commit. */
    if( ai==0 ) return;
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
  /* If the hook failed, report the changes again with the next commit. */
  if( rc==SQLITE_OK ) ovResetDirty(ov);
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

/* Free an overlay whose last connection has closed. Caller holds gMutex. */
static void ovDestroyLocked(Overlay *ov){
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
  if( ov->pBase ){
    if( ov->pBase->pMethods ) ov->pBase->pMethods->xClose(ov->pBase);
    sqlite3_free(ov->pBase);
  }
#ifndef OVERLAY_OMIT_BASE
  sqlite3_free_filename(ov->zPath);
#endif
  sqlite3_free(ov->zName);
  sqlite3_free(ov);
}

#ifndef OVERLAY_OMIT_BASE
/* Open the base file read-only and lock it against writers. */
static int ovOpenBase(Overlay *ov, const char *zPath, i64 *pSize){
  int outFlags = 0;
  int rc;
  /* A private filename object keeps URI lookups by the OS VFS valid after
  ** the connection that created the overlay has closed. */
  ov->zPath = sqlite3_create_filename(zPath, "", "", 0, 0);
  ov->pBase = sqlite3_malloc(gOrig->szOsFile);
  if( ov->zPath==0 || ov->pBase==0 ) return SQLITE_NOMEM;
  memset(ov->pBase, 0, gOrig->szOsFile);
  rc = gOrig->xOpen(gOrig, ov->zPath, ov->pBase,
                    SQLITE_OPEN_READONLY|SQLITE_OPEN_MAIN_DB, &outFlags);
  if( rc!=SQLITE_OK ) return rc;
  /* Keep other connections from modifying the base while we depend on it. */
  rc = ov->pBase->pMethods->xLock(ov->pBase, SQLITE_LOCK_SHARED);
  if( rc!=SQLITE_OK ) return rc;
  return ov->pBase->pMethods->xFileSize(ov->pBase, pSize);
}
#endif

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

#ifndef OVERLAY_OMIT_BASE
  rc = ovOpenBase(ov, zPath, &szBase);
  if( rc!=SQLITE_OK ) goto failed;
#else
  (void)zPath;
#endif

  if( pSrc ){
    i64 i;
    ov->szChunk = pSrc->szChunk;
    ov->bPatchWal = pSrc->bPatchWal;
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
    u8 h[100];
    if( szBase>=100 ){
      rc = ov->pBase->pMethods->xRead(ov->pBase, h, 100, 0);
      if( rc!=SQLITE_OK ) goto failed;
      ovUsePageSize(ov, h);
      ov->bPatchWal = ovIsWalHeader(h);
    }
    ov->szFile = ov->szVisible = szBase;
  }

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
    /* Committed, and still holding the write lock. */
    ovReportCommit(ov);
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

static const sqlite3_io_methods ovIoMethods = {
  1,                          /* iVersion: no shared memory, no mmap */
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
  0, 0, 0, 0, 0, 0
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
