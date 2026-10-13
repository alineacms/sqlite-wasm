# Changelog

## 0.8.3

- Saves that write the whole database write a compacted copy, as `VACUUM
  INTO` would: every table and index in order, without free pages. Full
  saves used to keep every page where it was, so syncs that change rows all
  over scattered tables further with every save (alinea measured 95% of an
  entry table's leaf pages in order after a sync from scratch, 24% after
  200 syncs), and reads from a stored snapshot, which read ahead in blocks,
  read nearly a block per page. The database moves onto the copy at once,
  and its next deltas lie over it. A database that changed since the save
  was called, or is in a transaction or reading then, cannot move onto
  another layout: that save writes in place, as before. Compacting reads
  the database into memory at once, then copies it while the Worker waits
  (0.6 s for 140 MB in Chromium); the copy is kept as Blobs.
- New save option `compact`: `true` writes a compacted copy now, also where
  a delta would do (after a large sync, say); `false` never compacts.
  `autoSave` takes it too.
- Fix the block cache of 0.8.2, which was never published: once the blocks
  in use filled it, blocks read ahead were dropped as soon as they were
  read, so a scan read 1 MiB for every 16 KiB it used (8 GB for a 136 MB
  table in a benchmark). Blocks read along now keep a quarter of the
  cache, and push out the oldest blocks in use to get it.
- Snapshots, their format and the data stored are unchanged: compacted
  snapshots are ordinary full snapshots, and older versions read them.

## 0.8.2

- Faster random reads of snapshots stored as Blobs (`indexedDBSnapshots`,
  `opfsSnapshots`, and the snapshots deltas lie over), and of Blobs opened
  with `readOnlyFile` or `openOverlay`. 0.8.1 kept only the last 4 blocks
  of 1 MiB it read, and only for reads that ran forward. Any other read was
  its own `FileReaderSync` read, which costs about a millisecond however
  small, so full-text searches and index lookups made a read for nearly
  every page. Now every read goes through a cache of 16 KiB blocks, up to
  32 MiB per storage, shared by every database it opens and by snapshots
  that lie over the same one. A read of blocks that are not kept reads them,
  and the blocks around them that are not kept either (the aligned 256 KiB,
  or 1 MiB ahead for reads that run forward), with one `FileReaderSync`
  read per run. The blocks around wait apart until they are used, and leave
  the cache first.
- New option `readCache: {blockSize, cacheBytes, readAround, readAhead}` for
  `indexedDBSnapshots`, `opfsSnapshots` and `SnapshotStorage`. `readOnlyFile`
  takes the same options. Its `blocks` option is deprecated in favour of
  `cacheBytes`, and still counts blocks of 1 MiB unless `blockSize` is given.
- Snapshots, their format and the data stored are unchanged.
