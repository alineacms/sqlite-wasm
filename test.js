import {init} from '@alinea/sqlite-wasm'

init().then(({Database}) => {
  const db = new Database()
  console.log(db.exec('select sqlite_version();'))
})