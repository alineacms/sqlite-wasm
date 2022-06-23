import wasmExports from './sqlite3-emscripten.wasm'
import {Imports, loadModule} from './load-module.js'

async function getWasmModule(
  exports: typeof wasmExports,
  imports: Imports
): Promise<WebAssembly.Instance> {
  if (typeof exports === 'function') return exports(imports)
  if (exports instanceof WebAssembly.Module)
    return WebAssembly.instantiate(module, imports)
  throw new Error(`Unable to load wasm module`)
}

function getModule(imports: Imports) {
  return getWasmModule(wasmExports, imports)
}

export function init() {
  return loadModule(getModule)
}

export default init
