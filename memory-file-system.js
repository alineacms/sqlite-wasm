// An in-memory file system with the same synchronous access as OPFS, which
// Bun does not have, for the storage tests. `failWrites` makes writes to a
// file fail, to interrupt a commit halfway.

export class MemoryFile {
  data = new Uint8Array(0)
  size = 0
  open = false
  failWrites = false

  read(buffer, {at}) {
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

  flush() {}

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
}
