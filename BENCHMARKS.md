# Snapshot storage benchmarks

Snapshot storage (`@alinea/sqlite-wasm/snapshots`, see the README) keeps
immutable bases either as files in OPFS (`opfsSnapshotStorage`) or as Blobs
in IndexedDB (`indexedDBSnapshotStorage`). Everything above the store (the
overlay over a read-only base, the changed pages, rebase, the API) is the
same. These are measurements of both, to pick one for alinea's dashboard,
where one SharedWorker per build opens an overlay over a shared base.

## Recommendation

**Use OPFS files.** They perform evenly in all three browsers: checkpoints
take 0.25–0.51 s whatever changed, never copy more than 4 MB out of Wasm
at once, and work in SharedWorkers and dedicated Workers everywhere.
IndexedDB Blobs mostly read faster (up to 1.5× in Chromium and WebKit,
about even in Firefox) and need no locks, but in WebKit a
checkpoint takes 4–8 s (11 s for a Blob of 80 parts, see below): only one
checkpoint fit in the 30-second run, against 29 with files. That is the
WebKit build Playwright ships for Linux; Safari on macOS may behave
differently and was not measured. If Safari does not matter, IndexedDB is
the better choice: faster reads, faster checkpoints in Chromium and Firefox,
no Web Locks, and a deleted base stays readable.

Whichever is chosen, the page cache matters more than the store. Reading a
page from a base takes 0.5–2 ms. With the default 8 MB cache (128 pages of
64 KB), a range scan that touches the whole 47 MB table reads it again
every time (0.5–2.4 s, cold and warm alike); with a 64 MB cache the second
run takes 4–6 ms. Set `PRAGMA cache_size` on the dashboard's database (and
its forks) to fit the hot part of the content.

## Setup

- The database: 20,000 entries with JSON-like data of about 2.4 KB, a
  unique index on entry id and locale, indexes on type and path and on
  parent: 47 MB in 724 pages of 64 KB (`test/browser/bench-data.js`). The
  page cache is the default for databases on a base, 8 MB, except in 3b.
- Each measurement runs in new SharedWorkers of one page, in headless
  Playwright builds of each browser; `bun script/test-browser.ts --bench
  --browser <name>` runs them and writes `bench-results/<name>.json`, and
  `bun script/benchmark-report.ts` prints these tables.
- 1: build the database in memory, then write it as the first base.
  2: open an overlay on it in a new Worker, until a point lookup returns.
  3: a point lookup by entry id; a range of 1,160 entries by type and path
  that reads their data (spread over the whole table); a full scan of the
  data. Cold on a fresh fork, warm right after on the same one.
  4: change 10, then 1,000, then 20,000 rows, spread over the table, and
  checkpoint after each (one database, so each checkpoint follows the
  previous one). "Pages held" is what the overlay held before; the Wasm
  heap is sampled every 2 ms during the checkpoint. Workers cannot measure
  their JS heap, so the last column is what the implementation copies out
  of Wasm at once: OPFS writes runs of up to 4 MB, IndexedDB puts every
  changed page in one Blob (outside the JS heap, until it is stored).
  5: one Worker changes 100 rows, checkpoints and cleans up in a loop for
  30 s, while another, on the first base, reads (a point lookup and a
  range count) and writes its own overlay, checking what it reads every
  round. Then a third opens the newest base and checks it holds every
  checkpoint. With locks, OPFS keeps the base the reader holds: 2 bases;
  IndexedDB keeps 1.
  6: delete the stored base under an open database (bypassing locks), then
  read the whole table from a fresh fork.
  7: open, change, checkpoint twice and reopen a small database.

## Results

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, 16 GiB, Linux 6.18.44-fc-v80. Browsers: chromium 141.0.0.0, firefox 155.0, webkit 26.6 (Playwright builds, headless). Run on 2026-10-08.
### 1. Writing the first base

| Browser | Bases | Size (MB) | Time (ms) | Wasm heap (MB) | Wasm growth (MB) |
| --- | --- | --- | --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | 47.4 | 245 | 50.7 | 0.0 |
| chromium 141.0.0.0 | IndexedDB Blobs | 47.4 | 180 | 50.7 | 0.0 |
| firefox 155.0 | OPFS files | 47.4 | 254 | 50.7 | 0.0 |
| firefox 155.0 | IndexedDB Blobs | 47.4 | 251 | 50.7 | 0.0 |
| webkit 26.6 | OPFS files | 47.4 | 542 | 50.7 | 0.0 |
| webkit 26.6 | IndexedDB Blobs | 47.4 | 568 | 50.7 | 0.0 |

### 2. Opening an overlay

| Browser | Bases | Open (ms) | To first query (ms) |
| --- | --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | 15.8 | 23.6 |
| chromium 141.0.0.0 | IndexedDB Blobs | 37.8 | 45.0 |
| firefox 155.0 | OPFS files | 9.00 | 12.0 |
| firefox 155.0 | IndexedDB Blobs | 6.00 | 8.00 |
| webkit 26.6 | OPFS files | 15.0 | 21.0 |
| webkit 26.6 | IndexedDB Blobs | 19.0 | 24.0 |

### 3. Queries (default page cache, 8 MB)

| Browser | Bases | Point cold | Point warm | Range cold | Range warm | Full cold | Full warm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | 10.4 | 0.20 | 2246 | 2372 | 1527 | 1673 |
| chromium 141.0.0.0 | IndexedDB Blobs | 6.50 | 0.10 | 1648 | 2011 | 1560 | 1160 |
| firefox 155.0 | OPFS files | 7.00 | 0.00 | 746 | 607 | 346 | 312 |
| firefox 155.0 | IndexedDB Blobs | 3.00 | 0.00 | 594 | 495 | 403 | 418 |
| webkit 26.6 | OPFS files | 5.00 | 0.00 | 1266 | 1249 | 777 | 779 |
| webkit 26.6 | IndexedDB Blobs | 4.00 | 0.00 | 925 | 978 | 591 | 467 |

### 3b. Queries with a 64 MB page cache, which holds the database

| Browser | Bases | Point cold | Point warm | Range cold | Range warm | Full cold | Full warm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | 15.1 | 0.60 | 1432 | 4.10 | 1417 | 54.4 |
| chromium 141.0.0.0 | IndexedDB Blobs | 7.70 | 0.20 | 1033 | 3.50 | 903 | 31.4 |
| firefox 155.0 | OPFS files | 2.00 | 0.00 | 312 | 6.00 | 413 | 34.0 |
| firefox 155.0 | IndexedDB Blobs | 2.00 | 0.00 | 314 | 4.00 | 480 | 32.0 |
| webkit 26.6 | OPFS files | 4.00 | 1.00 | 692 | 4.00 | 744 | 33.0 |
| webkit 26.6 | IndexedDB Blobs | 3.00 | 0.00 | 551 | 5.00 | 575 | 34.0 |

### 4. Checkpoints after changing rows

| Browser | Bases | Rows | Pages held (MB) | Time (ms) | Wasm heap (MB) | Wasm growth (MB) | Copied out of Wasm at once (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | 10 | 1.2 | 252 | 50.7 | 0.0 | 1.2 |
| chromium 141.0.0.0 | OPFS files | 1000 | 46.3 | 484 | 146.5 | 0.0 | 4.2 |
| chromium 141.0.0.0 | OPFS files | 20000 | 50.4 | 455 | 146.5 | 0.0 | 4.2 |
| chromium 141.0.0.0 | IndexedDB Blobs | 10 | 1.2 | 156 | 50.7 | 0.0 | 1.2 |
| chromium 141.0.0.0 | IndexedDB Blobs | 1000 | 46.3 | 255 | 146.5 | 0.0 | 46.3 |
| chromium 141.0.0.0 | IndexedDB Blobs | 20000 | 50.4 | 784 | 146.5 | 0.0 | 50.4 |
| firefox 155.0 | OPFS files | 10 | 1.2 | 434 | 50.7 | 0.0 | 1.2 |
| firefox 155.0 | OPFS files | 1000 | 46.3 | 506 | 146.5 | 0.0 | 4.2 |
| firefox 155.0 | OPFS files | 20000 | 50.4 | 483 | 146.5 | 0.0 | 4.2 |
| firefox 155.0 | IndexedDB Blobs | 10 | 1.2 | 264 | 50.7 | 0.0 | 1.2 |
| firefox 155.0 | IndexedDB Blobs | 1000 | 46.3 | 247 | 146.5 | 0.0 | 46.3 |
| firefox 155.0 | IndexedDB Blobs | 20000 | 50.4 | 293 | 146.5 | 0.0 | 50.4 |
| webkit 26.6 | OPFS files | 10 | 1.2 | 343 | 50.7 | 0.0 | 1.2 |
| webkit 26.6 | OPFS files | 1000 | 46.3 | 454 | 146.5 | 0.0 | 4.2 |
| webkit 26.6 | OPFS files | 20000 | 50.4 | 466 | 146.5 | 0.0 | 4.2 |
| webkit 26.6 | IndexedDB Blobs | 10 | 1.2 | 4155 | 50.7 | 0.0 | 1.2 |
| webkit 26.6 | IndexedDB Blobs | 1000 | 46.3 | 8303 | 146.5 | 0.0 | 46.3 |
| webkit 26.6 | IndexedDB Blobs | 20000 | 50.4 | 4405 | 146.5 | 0.0 | 50.4 |

### 5. Two SharedWorkers on one base

| Browser | Bases | Seconds | Checkpoints | Reader rounds | Bases left (expected) | Correct |
| --- | --- | --- | --- | --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | 30 | 28 | 5532 | 2 (2) | yes |
| chromium 141.0.0.0 | IndexedDB Blobs | 30 | 30 | 5562 | 1 (1) | yes |
| firefox 155.0 | OPFS files | 30 | 47 | 5605 | 2 (2) | yes |
| firefox 155.0 | IndexedDB Blobs | 30 | 56 | 5549 | 1 (1) | yes |
| webkit 26.6 | OPFS files | 30 | 29 | 5714 | 2 (2) | yes |
| webkit 26.6 | IndexedDB Blobs | 30 | 1 | 5349 | 1 (1) | yes |

### 6. Reading a base after its stored entry was deleted

| Browser | Bases | Result |
| --- | --- | --- |
| chromium 141.0.0.0 | OPFS files | fails: disk I/O error |
| chromium 141.0.0.0 | IndexedDB Blobs | reads every page |
| firefox 155.0 | OPFS files | fails: disk I/O error |
| firefox 155.0 | IndexedDB Blobs | reads every page |
| webkit 26.6 | OPFS files | fails: disk I/O error |
| webkit 26.6 | IndexedDB Blobs | reads every page |

### 7. Support

| Browser | SharedWorker, OPFS | SharedWorker, IndexedDB | Worker, OPFS | Worker, IndexedDB |
| --- | --- | --- | --- | --- |
| chromium 141.0.0.0 | works | works | works | works |
| firefox 155.0 | works | works | works | works |
| webkit 26.6 | works | works | works | works |


### WebKit and Blobs in IndexedDB

Why checkpoints to IndexedDB are slow in WebKit, measured with plain
IndexedDB in a Worker (no SQLite), with a stored 47 MB Blob:

| Storing | WebKit 26.6 (ms) | Firefox 155 (ms) |
| --- | --- | --- |
| A new 47 MB Blob from memory | 364–530 | 206 |
| The stored Blob again | 66–292 | 2 |
| A 1,000-byte slice of it | 51–259 | 1 |
| 5 parts: slices of it and two 64 KB pages | 841–913 | 87 |
| 80 parts: slices of it and 40 pages | 10,734–11,370 | not measured |

WebKit copies stored Blob data when it stores a Blob made from it, and its
cost grows with the number of parts. A checkpoint of changes spread over
the database is such a Blob: one part per run of unchanged pages and per
run of changed pages.
