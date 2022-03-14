import {decode} from 'base64-arraybuffer'
import initialize, { SQLite3Wasm } from './sqlite3-emscripten.js'

const wasmSource = decode('$SRC')

async function instantiateWasm(imports: any, resolve: (instance: any) => void) {
  const module = await WebAssembly.compile(wasmSource)
  const instance = await WebAssembly.instantiate(module, imports)
  resolve(instance)
}

export function init(): Promise<SQLite3Wasm> {
  return initialize({instantiateWasm: instantiateWasm as any})
}