// An in-memory file system with the same synchronous access as OPFS, which
// Bun does not have, for the storage tests. `failWrites` makes writes to a
// file fail, to interrupt a commit halfway (`failReads` makes reads fail),
// and `afterCrash()` returns the
// files as a crash would leave them: as they were when last flushed.

export class MemoryFile {
  data = new Uint8Array(0)
  size = 0
  synced = new Uint8Array(0)
  open = false
  failWrites = false
  failReads = false

  read(buffer, {at}) {
    if (this.failReads) throw new Error('read failed')
    const n = Math.max(0, Math.min(buffer.length, this.size - at))
    buffer.set(this.data.subarray(at, at + n))
    return n
  }

  write(buffer, {at}) {
    if (this.failWrites) throw new Error('write failed')
    const end = at + buffer.length
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2))
      grown.set(this.data.subarray(0, this.size))
      this.data = grown
    }
    if (at > this.size) this.data.fill(0, this.size, at)
    this.data.set(buffer, at)
    this.size = Math.max(this.size, end)
    return buffer.length
  }

  truncate(size) {
    if (size < this.size) this.data.fill(0, size, this.size)
    this.size = size
  }

  getSize() {
    return this.size
  }

  flush() {
    this.synced = this.bytes()
  }

  close() {
    this.open = false
  }

  bytes() {
    return this.data.slice(0, this.size)
  }
}

export class MemoryFileSystem {
  files = new Map()

  file(name) {
    let file = this.files.get(name)
    if (!file) this.files.set(name, (file = new MemoryFile()))
    return file
  }

  async open(name) {
    const file = this.file(name)
    if (file.open) throw new Error(`${name} is open`)
    file.open = true
    return file
  }

  async remove(name) {
    this.files.delete(name)
  }

  afterCrash() {
    const copy = new MemoryFileSystem()
    for (const [name, file] of this.files) {
      const durable = copy.file(name)
      durable.write(file.synced, {at: 0})
      durable.flush()
    }
    return copy
  }
}

// A directory of base files for snapshot storage, like OPFS with
// createWritable(): a file being written is empty until the writer closes,
// and then appears in full. `get` returns the content as it is, which stays
// as it is, like a File. Every operation waits a moment, so other work
// runs in between, and `failWrites` makes writing fail.
export class MemorySnapshotDirectory {
  files = new Map()
  clock = 0
  failWrites = false

  supported() {
    return true
  }

  async list() {
    await tick()
    return [...this.files].map(([name, file]) => ({
      name,
      size: file.data.byteLength,
      lastModified: file.lastModified
    }))
  }

  async get(name) {
    await tick()
    return this.files.get(name)?.data
  }

  /** Put `data` in file `name`, as if a writer wrote it. */
  set(name, data) {
    this.files.set(name, {data, lastModified: ++this.clock})
  }

  async create(name) {
    await tick()
    if (!this.files.has(name)) this.set(name, new Uint8Array(0))
    const file = new MemoryFile()
    const write = async action => {
      await tick()
      if (this.failWrites) throw new Error('write failed')
      action()
    }
    return {
      copy: source => write(() => file.write(source, {at: 0})),
      write: async (data, position) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())
        return write(() => file.write(bytes, {at: position}))
      },
      truncate: size =>
        write(() => {
          if (size < file.size) file.truncate(size)
          else file.write(new Uint8Array(0), {at: size})
        }),
      close: () => write(() => this.set(name, file.bytes())),
      abort: async () => {
        if (this.files.get(name)?.data.byteLength === 0) this.files.delete(name)
      }
    }
  }

  async remove(name) {
    await tick()
    this.files.delete(name)
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// The parts of the Web Locks API snapshot storage uses: shared and
// exclusive locks, granted in order, and ifAvailable.
export class MemoryLocks {
  held = new Map()
  waiting = new Map()

  request(name, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const mode = options.mode ?? 'exclusive'
    return new Promise((resolve, reject) => {
      const run = () => {
        const state = this.held.get(name) ?? {mode, count: 0}
        state.count++
        this.held.set(name, state)
        Promise.resolve()
          .then(() => callback({name, mode}))
          .then(resolve, reject)
          .finally(() => {
            if (--state.count === 0) this.held.delete(name)
            this.next(name)
          })
      }
      const queue = this.waiting.get(name) ?? []
      this.waiting.set(name, queue)
      if (queue.length === 0 && this.compatible(name, mode)) run()
      else if (options.ifAvailable) {
        Promise.resolve()
          .then(() => callback(null))
          .then(resolve, reject)
      } else queue.push({mode, run})
    })
  }

  compatible(name, mode) {
    const held = this.held.get(name)
    return !held || (mode === 'shared' && held.mode === 'shared')
  }

  next(name) {
    const queue = this.waiting.get(name) ?? []
    while (queue.length && this.compatible(name, queue[0].mode)) {
      queue.shift().run()
    }
  }
}

// FileReaderSync, which Bun lacks, for Blobs in memory: Bun resolves
// reading them right away, which Bun.peek returns synchronously.
export class MemoryFileReaderSync {
  readAsArrayBuffer(blob) {
    const result = Bun.peek(blob.arrayBuffer())
    if (result instanceof Promise) throw new Error('Blob is not in memory')
    return result
  }
}
