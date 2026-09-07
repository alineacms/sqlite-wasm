import {deflateSync} from 'node:zlib'

const source = await Bun.file('./dist/init-base64.js').text()
const wasm = await Bun.file('./dist/sqlite3-emscripten.wasm').arrayBuffer()
const compressed = deflateSync(new Uint8Array(wasm), {level: 9})
await Bun.write(
  './dist/init-base64.js',
  source.replace('$SRC', compressed.toString('base64'))
)
