import {Database as DatabaseImpl} from './Database.js'
import initialize, {SQLite3Wasm} from './sqlite3-emscripten.cjs'

export interface Database {
  new (data?: ArrayBufferView): DatabaseImpl
}

let promisedModule: Promise<SQLite3Wasm> | undefined

export async function init(): Promise<{wasm: SQLite3Wasm; Database: Database}> {
  const wasm = await (promisedModule || (promisedModule = initialize()))
  return {
    wasm,
    Database: class extends DatabaseImpl {
      constructor(data?: ArrayBufferView) {
        super(wasm, data)
      }
    }
  }
}
