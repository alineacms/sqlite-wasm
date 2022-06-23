import {encode} from 'base64-arraybuffer'
import fs from 'fs'

let source = fs.readFileSync('./dist/init-base64.js', 'utf-8')
source = source.replace(
  '$SRC',
  encode(fs.readFileSync('./dist/sqlite3-emscripten.wasm'))
)
fs.writeFileSync('./dist/init-base64.js', source)
