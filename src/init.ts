import {decode} from 'base64-arraybuffer'
import initialize, {SQLite3Wasm} from './sqlite3-emscripten.cjs'
import {Database as DatabaseImpl} from './Database.js'

const wasmSource = decode('$SRC')

async function instantiateWasm(imports: any, resolve: (instance: any) => void) {
  const module = await WebAssembly.compile(wasmSource)
  const instance = await WebAssembly.instantiate(module, imports)
  resolve(instance)
}

export interface Database {
  new (data?: ArrayBufferView): DatabaseImpl
}

let promisedModule: Promise<SQLite3Wasm> | undefined

export async function init(): Promise<{wasm: SQLite3Wasm; Database: Database}> {
  const wasm = await (promisedModule ||
    (promisedModule = initialize({instantiateWasm: instantiateWasm as any})))
  return {
    wasm,
    Database: class extends DatabaseImpl {
      constructor(data?: ArrayBufferView) {
        super(wasm, data)
      }
    }
  }
}
