import fs from 'fs'

function snipBetween(source, start, end) {
  const startOfNonsense = source.indexOf(start)
  const endOfNonsense = source.indexOf(end)
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
source = 'import {crypto} from "@alinea/iso"\n' + source
fs.writeFileSync('./src/sqlite3-emscripten.js', source)
