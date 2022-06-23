declare module '*.wasm' {
  type WasmExport =
    | ((imports: Record<string, any>) => WebAssembly.Module)
    | WebAssembly.Module
  const wasmExports: WasmExport
  export default wasmExports
}
