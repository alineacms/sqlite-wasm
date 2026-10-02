// Prototype 1: SQLite files in OPFS through sync access handles, answered
// synchronously, for the synchronous build. Sync access handles exist only
// in dedicated Workers, so this runs in one; tabs pass it their queries.
//
// Handles are opened up front (opening is async), for the database and its
// rollback journal. Like opfs-sahpool, deleting a file truncates it, and a
// file exists while it is not empty, so the handles stay open.

const SQLITE_IOERR_SHORT_READ = 522
const SQLITE_IOERR_WRITE = 778

export async function createOPFSBackend(module, name) {
  const root = await navigator.storage.getDirectory()
  const handles = new Map()
  for (const file of [name, `${name}-journal`]) {
    const fileHandle = await root.getFileHandle(file, {create: true})
    handles.set(file, await fileHandle.createSyncAccessHandle())
  }
  const byId = [...handles.values()]
  const ids = new Map([...handles.keys()].map((file, id) => [file, id]))
  module.jsvfs = {
    open: (file) => ids.get(file) ?? -1,
    close: () => 0,
    read(id, ptr, size, offset) {
      const target = module.HEAPU8.subarray(ptr, ptr + size)
      const read = byId[id].read(target, {at: offset})
      if (read < size) {
        target.fill(0, read)
        return SQLITE_IOERR_SHORT_READ
      }
      return 0
    },
    write(id, ptr, size, offset) {
      const written = byId[id].write(module.HEAPU8.subarray(ptr, ptr + size), {at: offset})
      return written === size ? 0 : SQLITE_IOERR_WRITE
    },
    truncate(id, size) {
      byId[id].truncate(size)
      return 0
    },
    sync(id) {
      byId[id].flush()
      return 0
    },
    size: (id) => byId[id].getSize(),
    delete(file) {
      handles.get(file)?.truncate(0)
      return 0
    },
    exists: (file) => ((handles.get(file)?.getSize() ?? 0) > 0 ? 1 : 0),
  }
  return {
    flush: async () => {},
    close() {
      for (const handle of handles.values()) handle.close()
    },
  }
}
