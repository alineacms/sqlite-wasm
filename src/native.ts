import {existsSync, readdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

function isMusl() {
  try {
    return readdirSync('/lib').some(file => file.startsWith('ld-musl-'))
  } catch {
    return false
  }
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
