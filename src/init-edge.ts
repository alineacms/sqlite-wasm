// @ts-ignore This is how Vercel does it, with the edge export condition
import wasmExports from './sqlite3-emscripten.wasm?module'
import {Imports, loadModule} from './load-module.js'

function getWasmModule(
  exports: typeof wasmExports,
  imports: Imports
): Promise<WebAssembly.Instance> {
  if (exports instanceof WebAssembly.Module)
    return WebAssembly.instantiate(exports, imports)
  throw new Error(`Unable to load wasm module`)
}

function getModule(imports: Imports) {
  return getWasmModule(wasmExports, imports)
}

export function init() {
  return loadModule(getModule)
}

export default init
