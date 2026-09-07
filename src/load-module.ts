import {Database as DatabaseImpl} from './Database.js'
import initialize from './sqlite3-emscripten.js'
import type {SQLite3Wasm} from './sqlite3-emscripten.js'

export interface Database {
  new (data?: ArrayBufferView): DatabaseImpl
}

export type Imports = WebAssembly.Imports

type Loader = (imports: Imports) => Promise<WebAssembly.Instance>

async function load(loader: Loader) {
  const wasm = await initialize({
    instantiateWasm(
      info: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance) => void
    ): undefined {
      loader(info).then(receive)
      return undefined
    }
  })
  return {
    wasm,
    Database: class extends DatabaseImpl {
      constructor(data?: ArrayBufferView) {
        super(wasm, data)
      }
    }
  }
}

const cached = new WeakMap<Loader, Promise<ReturnType<typeof load> extends Promise<infer T> ? T : never>>()

export function loadModule(
  loader: Loader
): Promise<{wasm: SQLite3Wasm; Database: Database}> {
  const existing = cached.get(loader)
  if (existing) return existing
  const pending = load(loader)
  cached.set(loader, pending)
  return pending
}
