// A dedicated Worker the browser tests drive: each message names an action
// on the database it holds, and is answered with its result or error.
import {init} from '@alinea/sqlite-wasm'
import {opfsStorage} from '@alinea/sqlite-wasm/opfs'

const {Database} = await init()
let db

const rows = sql => db.exec(sql)[0]?.values ?? []

const actions = {
  async open({file}) {
    db = await Database.sync(opfsStorage(file))
  },
  memory() {
    db = new Database()
  },
  run({sql, params}) {
    db.run(sql, params)
  },
  rows: ({sql}) => rows(sql),
  fill({count, size}) {
    db.run('create table if not exists items (id integer primary key, body text)')
    db.run('begin')
    const insert = db.prepare('insert into items (body) values (?)')
    for (let i = 0; i < count; i++) insert.run([`${i} `.padEnd(size, 'x')])
    insert.free()
    db.run('commit')
  },
  fork() {
    const fork = db.fork()
    db.close()
    db = fork
  },
  attach: ({file}) => db.attach(opfsStorage(file)),
  detach: () => db.detach(),
  flush: () => db.flush(),
  close() {
    db.close()
  },
  remove: ({file}) => opfsStorage(file).delete(),
  async size({file}) {
    const root = await navigator.storage.getDirectory()
    try {
      return (await (await root.getFileHandle(file)).getFile()).size
    } catch {
      return -1
    }
  }
}

self.onmessage = async ({data: {id, action, args}}) => {
  try {
    self.postMessage({id, result: await actions[action](args ?? {})})
  } catch (error) {
    self.postMessage({id, error: {message: error.message, code: error.code}})
  }
}
self.postMessage({ready: true})
