import fs from 'fs'

function snipBetween(source, start, end) {
  const startOfNonsense = source.indexOf(start)
  const endOfNonsense = source.indexOf(end)
  if (startOfNonsense === -1) throw 'Start not found'
  if (endOfNonsense === -1) throw 'End not found'
  return (
    source.slice(0, startOfNonsense) + source.slice(endOfNonsense + end.length)
  )
}

let source = fs.readFileSync('./cache/sqlite3-emscripten.js', 'utf-8')
source = source.replace(
  'var ENVIRONMENT_IS_WEB = typeof window == "object";',
  ''
)
source = source.replace(
  'var ENVIRONMENT_IS_WORKER = typeof importScripts == "function";',
  ''
)
source = source.replace(
  'var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string";',
  ''
)
source = source.replace(
  'wasmBinaryFile = new URL("sqlite3-emscripten.wasm", import.meta.url).toString();',
  ''
)
source = snipBetween(
  source,
  'function LazyUint8Array() {',
  'node.stream_ops = stream_ops;\n  return node;'
)
source = 'import {crypto} from "@alinea/iso"\n' + source
fs.writeFileSync('./src/sqlite3-emscripten.js', source)
