import {Database as DatabaseImpl} from './Database.js'
import initialize from './sqlite3-emscripten.js'
import type {SQLite3Wasm} from './sqlite3-emscripten.js'

export interface Database {
  new (data?: ArrayBufferView): DatabaseImpl
}

export type Imports = {
  [key: string]: any
}

type Loader = (imports: Imports) => Promise<WebAssembly.Instance>

async function load(loader: Loader) {
  let trigger: () => void
  let load = new Promise(resolve => (trigger = () => resolve(undefined)))
  const wasm = await initialize({
    instantiateWasm(info: any, receive: (m: WebAssembly.Module) => void): any {
      loader(info)
        .then(instance => receive(instance))
        .finally(trigger)
    }
  })
  await load
  return {
    wasm,
    Database: class extends DatabaseImpl {
      constructor(data?: ArrayBufferView) {
        super(wasm, data)
      }
    }
  }
}

let cached = new WeakMap()

export function loadModule(
  loader: Loader
): Promise<{wasm: SQLite3Wasm; Database: Database}> {
  if (!cached.has(loader)) cached.set(loader, load(loader))
  return cached.get(loader)
}
