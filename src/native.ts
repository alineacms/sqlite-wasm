import {existsSync, readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

let musl: boolean | undefined
function isMusl() {
  if (musl === undefined) {
    // Same checks as detect-libc: the runtime reports the glibc version it
    // runs on, otherwise ldd names the libc it belongs to.
    const header = (process.report?.getReport() as any)?.header
    if (header && 'glibcVersionRuntime' in header) musl = false
    else {
      try {
        musl = readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
      } catch {
        musl = false
      }
    }
  }
  return musl
}

/**
 * Name of the prebuilt binary directory for a platform, e.g. `linux-x64` or
 * `linux-arm64-musl`. macOS ships a single universal binary.
 */
export function nativeTarget(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  if (platform === 'darwin') return 'darwin'
  if (platform === 'linux') return `linux-${arch}${isMusl() ? '-musl' : ''}`
  return `${platform}-${arch}`
}

/**
 * Path of the prebuilt `overlay` SQLite extension for this platform, for use
 * with `loadExtension` in node:sqlite, bun:sqlite or other native drivers.
 * Loading it registers the process-wide `overlay` VFS:
 *
 * ```ts
 * import {DatabaseSync} from 'node:sqlite'
 * import {overlayExtension} from '@alinea/sqlite-wasm/native'
 *
 * new DatabaseSync(':memory:', {allowExtension: true})
 *   .loadExtension(overlayExtension())
 * const db = new DatabaseSync('file:base.db?vfs=overlay')
 * ```
 *
 * The path has no file extension; SQLite adds the platform's own.
 */
export function overlayExtension(): string {
  const target = nativeTarget()
  const directory = new URL(`./native/${target}/`, import.meta.url)
  if (!existsSync(directory))
    throw new Error(`No prebuilt overlay extension for ${target}`)
  return fileURLToPath(new URL('overlay', directory))
}
