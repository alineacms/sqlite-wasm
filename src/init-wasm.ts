import wasmExports from './sqlite3-emscripten.wasm'
import {Imports, loadModule} from './load-module.js'

function getWasmModule(
  exports: typeof wasmExports,
  imports: Imports
): Promise<WebAssembly.Instance> {
  // Most bundler will have a plugin that exports wasm as an async function
  // to which imports can be passed
  if (typeof exports === 'function') return exports(imports)
  // Cloudflare workers
  if (exports instanceof WebAssembly.Module)
    return WebAssembly.instantiate(exports, imports)
  // Bun exports an absolute path
  if (typeof exports === 'string' && globalThis.Bun)
    return Bun.file(exports)
      .arrayBuffer()
      .then(WebAssembly.compile)
      .then(module => WebAssembly.instantiate(module, imports))
  throw new Error(`Unable to load wasm module`)
}

function getModule(imports: Imports) {
  return getWasmModule(wasmExports, imports)
}

export function init() {
  return loadModule(getModule)
}

export default init
