// A database file kept in IndexedDB as fixed-size blocks, with a bounded
// cache of clean blocks in memory: the storage beneath prototypes 2 and 3.
//
// Writes collect in `dirty` until SQLite syncs the file, and each sync is
// one IndexedDB transaction, so the stored file is always a committed state
// (the rollback journal is kept in memory). Synced blocks stay in memory
// until their transaction completes. Only clean blocks are evicted.

const BLOCKS = 'blocks'
const META = 'meta'

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })

export class PageStore {
  static async open(name, {blockSize = 4096, cacheBlocks = 256, prefetch = 16} = {}) {
    const open = indexedDB.open(name, 1)
    open.onupgradeneeded = () => {
      open.result.createObjectStore(BLOCKS)
      open.result.createObjectStore(META)
    }
    const idb = await request(open)
    const size = (await request(idb.transaction(META).objectStore(META).get('size'))) ?? 0
    return new PageStore(idb, size, blockSize, cacheBlocks, prefetch)
  }

  constructor(idb, size, blockSize, cacheBlocks, prefetch) {
    this.idb = idb
    this.size = size
    this.storedSize = size
    this.blockSize = blockSize
    this.cacheBlocks = cacheBlocks
    this.prefetch = prefetch
    this.cache = new Map()
    this.dirty = new Map()
    this.unsaved = new Map()
    this.writing = Promise.resolve()
    this.error = null
    this.pinned = false
    this.stats = {fetches: 0, fetchedBlocks: 0, commits: 0}
  }

  block(index) {
    const block = this.dirty.get(index) ?? this.unsaved.get(index)
    if (block) return block
    const cached = this.cache.get(index)
    if (cached) {
      this.cache.delete(index)
      this.cache.set(index, cached)
    }
    return cached
  }

  // Copy [offset, offset + size) into target, or return the indexes of the
  // blocks that must be fetched first. Bytes past the end read as zeros.
  read(target, offset) {
    const {blockSize} = this
    let missing = null
    for (let pos = 0; pos < target.length; ) {
      const at = offset + pos
      const index = Math.floor(at / blockSize)
      const start = at - index * blockSize
      const length = Math.min(blockSize - start, target.length - pos)
      if (at >= this.size) {
        target.fill(0, pos, pos + length)
      } else {
        const block = this.block(index)
        if (block) target.set(block.subarray(start, start + length), pos)
        else (missing ??= []).push(index)
      }
      pos += length
    }
    return missing
  }

  // Store source at offset, or return the blocks that must be fetched first
  // (only for partial writes to blocks that exist but are not in memory).
  write(source, offset) {
    const {blockSize} = this
    const blocks = []
    let missing = null
    for (let pos = 0; pos < source.length; ) {
      const at = offset + pos
      const index = Math.floor(at / blockSize)
      const start = at - index * blockSize
      const length = Math.min(blockSize - start, source.length - pos)
      let block
      if (length === blockSize) {
        block = new Uint8Array(blockSize)
      } else if (index * blockSize >= this.size) {
        block = new Uint8Array(blockSize)
      } else {
        const current = this.block(index)
        if (!current) (missing ??= []).push(index)
        else block = current.slice()
      }
      if (block) {
        block.set(source.subarray(pos, pos + length), start)
        blocks.push([index, block])
      }
      pos += length
    }
    if (missing) return missing
    for (const [index, block] of blocks) {
      this.dirty.set(index, block)
      this.cache.delete(index)
    }
    this.size = Math.max(this.size, offset + source.length)
    return null
  }

  truncate(size) {
    this.size = size
    const last = Math.ceil(size / this.blockSize)
    for (const map of [this.dirty, this.cache]) {
      for (const index of map.keys()) if (index >= last) map.delete(index)
    }
  }

  // Load the given blocks, each with the blocks after it, in one
  // transaction.
  async fetch(indexes) {
    const tx = this.idb.transaction(BLOCKS)
    const store = tx.objectStore(BLOCKS)
    const blockCount = Math.ceil(this.storedSize / this.blockSize)
    const ranges = []
    for (const index of new Set(indexes)) {
      const last = Math.min(index + this.prefetch, blockCount) - 1
      if (last < index) continue
      const range = IDBKeyRange.bound(index, last)
      ranges.push(Promise.all([request(store.getAllKeys(range)), request(store.getAll(range))]))
    }
    const results = await Promise.all(ranges)
    this.stats.fetches++
    for (const [keys, values] of results) {
      for (let i = 0; i < keys.length; i++) {
        const index = keys[i]
        if (this.dirty.has(index) || this.unsaved.has(index)) continue
        this.cache.set(index, new Uint8Array(values[i]))
        this.stats.fetchedBlocks++
      }
    }
    this.evict()
  }

  evict() {
    if (this.pinned) return
    for (const index of this.cache.keys()) {
      if (this.cache.size <= this.cacheBlocks) break
      this.cache.delete(index)
    }
  }

  // Start storing everything written since the last commit, as one
  // transaction after the ones already started. Resolves once stored.
  commit() {
    const blocks = this.dirty
    const size = this.size
    this.dirty = new Map()
    for (const [index, block] of blocks) this.unsaved.set(index, block)
    this.stats.commits++
    const write = async () => {
      const tx = this.idb.transaction([BLOCKS, META], 'readwrite')
      const store = tx.objectStore(BLOCKS)
      for (const [index, block] of blocks) store.put(block, index)
      const last = Math.ceil(size / this.blockSize)
      if (size < this.storedSize) store.delete(IDBKeyRange.lowerBound(last))
      tx.objectStore(META).put(size, 'size')
      await done(tx)
      this.storedSize = size
      for (const [index, block] of blocks) {
        if (this.unsaved.get(index) !== block) continue
        this.unsaved.delete(index)
        if (index < Math.ceil(this.size / this.blockSize)) this.cache.set(index, block)
      }
      this.evict()
    }
    this.writing = this.writing.then(write).catch((error) => {
      this.error ??= error
    })
    return this.writing
  }

  async flush() {
    await this.writing
    if (this.error) throw this.error
  }

  close() {
    this.idb.close()
  }
}
