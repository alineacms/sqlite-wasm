import fs from 'fs'

const source = fs.readFileSync('./dist/sqlite3-emscripten.cjs', 'utf-8')
const start = 'var scriptDirectory="";'
const end = 'title}}else{}'
const startOfNonsense = source.indexOf(start)
const endOfNonsense = source.indexOf(end)
if (startOfNonsense > -1 && endOfNonsense > -1)
  fs.writeFileSync(
    './dist/sqlite3-emscripten.cjs',
    source.slice(0, startOfNonsense) + source.slice(endOfNonsense + end.length)
  )
