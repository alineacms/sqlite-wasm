// Builds src/overlay.c as a loadable SQLite extension for the current
// platform into dist/native/<target>/, for node:sqlite, bun:sqlite and other
// native drivers. Compiles with MSVC on Windows ($CC or cc elsewhere).
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {nativeTarget} from '../src/native.ts'

const makefile = readFileSync('Makefile', 'utf8')
function variable(name: string) {
  const match = makefile.match(new RegExp(`^${name} := (.+)$`, 'm'))
  if (!match) throw new Error(`Missing ${name} in Makefile`)
  return match[1].trim()
}

function run(command: string, args: Array<string>) {
  console.log([command, ...args].join(' '))
  const result = spawnSync(command, args, {stdio: 'inherit'})
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

// The extension only needs sqlite3.h and sqlite3ext.h, from the same SQLite
// release as the Wasm build.
const source = variable('SQLITE_AUTOCONF')
const include = join('cache', source)
if (!existsSync(join(include, 'sqlite3ext.h'))) {
  const archive = join('cache', `${source}.tar.gz`)
  mkdirSync('cache', {recursive: true})
  if (!existsSync(archive)) {
    const response = await fetch(variable('SQLITE_AUTOCONF_URL'))
    if (!response.ok) throw new Error(`Download failed: ${response.status}`)
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
  }
  const digest = createHash('sha3-256').update(readFileSync(archive)).digest('hex')
  if (digest !== variable('SQLITE_AUTOCONF_SHA3')) {
    rmSync(archive)
    throw new Error(`Checksum mismatch for ${archive}`)
  }
  run('tar', ['-xzf', archive, '-C', 'cache', `${source}/sqlite3.h`, `${source}/sqlite3ext.h`])
}

const outDir = join('dist', 'native', nativeTarget())
mkdirSync(outDir, {recursive: true})

if (process.platform === 'win32') {
  run('cl', [
    '/nologo', '/O2', '/W3', '/LD', `/I${include}`, 'src/overlay.c',
    `/Fe${join(outDir, 'overlay.dll')}`, `/Fo${join('cache', 'overlay.obj')}`
  ])
  // Import library and exports file are only needed to link against the DLL.
  rmSync(join(outDir, 'overlay.lib'), {force: true})
  rmSync(join(outDir, 'overlay.exp'), {force: true})
} else {
  const darwin = process.platform === 'darwin'
  run(process.env.CC || 'cc', [
    '-O2', '-Wall', '-Wextra', `-I${include}`,
    ...(darwin
      ? ['-dynamiclib', '-undefined', 'dynamic_lookup', '-arch', 'arm64', '-arch', 'x86_64']
      : ['-shared', '-fPIC']),
    'src/overlay.c',
    '-o', join(outDir, darwin ? 'overlay.dylib' : 'overlay.so')
  ])
}
