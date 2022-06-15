import fs from 'fs'

function snipBetween(source, start, end) {
  const startOfNonsense = source.indexOf(start)
  const endOfNonsense = source.indexOf(end)
  return (
    source.slice(0, startOfNonsense) + source.slice(endOfNonsense + end.length)
  )
}

let source = fs.readFileSync('./cache/sqlite3-emscripten.js', 'utf-8')
source = snipBetween(source, 'var scriptDirectory="";', 'title}}else{}')
source = source.replace(
  'else if(ENVIRONMENT_IS_NODE){try{var crypto_module=require("crypto");return function(){return crypto_module["randomBytes"](1)[0]}}catch(e){}}',
  ''
)
source = 'import {crypto} from "@alinea/iso"\n' + source
fs.writeFileSync('./src/sqlite3-emscripten.js', source)
