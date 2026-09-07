declare module '*.wasm' {
  type WasmExport =
    | ((imports: Record<string, any>) => WebAssembly.Module)
    | WebAssembly.Module
  const wasmExports: WasmExport
  export default wasmExports
}

declare module 'buffer-to-base64/decode' {
  export function decode(
    base64: string,
    format?: CompressionFormat | ''
  ): Promise<ArrayBuffer>
}
