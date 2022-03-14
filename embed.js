import fs from 'fs'
import {encode} from 'base64-arraybuffer'

const source = fs.readFileSync('./dist/init.js', 'utf-8')
const sqlJs = fs.readFileSync('./dist/sqlite.wasm')
fs.writeFileSync('./dist/init.js', source.replace('$SRC', encode(sqlJs)))
