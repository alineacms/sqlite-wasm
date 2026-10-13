# Changelog

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
