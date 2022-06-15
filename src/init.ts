import {Database as DatabaseImpl} from './Database.js'
import initialize from './sqlite3-emscripten.js'
import type {SQLite3Wasm} from './sqlite3-emscripten.js'

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
