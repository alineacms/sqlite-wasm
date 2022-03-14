import {Database} from '@alinea/sqlite-wasm'
import {init} from '@alinea/sqlite-wasm/init'

init().then(wasm => {
  const db = new Database(wasm)
  console.log(db.exec('select sqlite_version();'))
})