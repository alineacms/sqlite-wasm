import {closeSync, fstatSync, openSync, readSync} from 'node:fs'
import type {SyncFile} from './opfs.js'
import {SQLiteError} from './SQLiteError.js'

// Files of the file system, for Node and Bun: with `openOverlay` (from
// '@alinea/sqlite-wasm/snapshots'), a database reads its pages from such a
// file as queries need them, instead of loading it into memory.

const SQLITE_READONLY = 8
const SQLITE_IOERR_READ = 266

/**
 * The file at `path`, opened for synchronous reads with `fs.readSync`. It
 * must not be written while it is open: nothing locks it, so each read
 * first checks that its size and modification time are as they were, and
 * fails with `SQLITE_IOERR_READ` if not. Replacing the file (writing a new
 * one and renaming it over the path) is safe: this one keeps reading the
 * file it opened. Closing it closes the file.
 */
export function readOnlyFileAt(path: string): SyncFile {
  const fd = openSync(path, 'r')
  let closed = false
  const {size, mtimeMs} = fstatSync(fd)
  const readOnly = () => {
    throw new SQLiteError('Files opened with readOnlyFileAt are read-only', SQLITE_READONLY)
  }
  return {
    read(buffer, {at}) {
      if (closed) throw new SQLiteError(`${path} is closed`, SQLITE_IOERR_READ)
      const now = fstatSync(fd)
      if (now.size !== size || now.mtimeMs !== mtimeMs)
        throw new SQLiteError(`${path} changed while it was open`, SQLITE_IOERR_READ)
      let read = 0
      while (read < buffer.length && at + read < size) {
        const n = readSync(fd, buffer, read, buffer.length - read, at + read)
        if (n === 0) break
        read += n
      }
      return read
    },
    getSize: () => size,
    write: readOnly,
    truncate: readOnly,
    flush() {},
    close() {
      if (closed) return
      closed = true
      closeSync(fd)
    }
  }
}
