const source = await Bun.file('./dist/init-base64.js').text()
if (!source.includes('$SRC')) {
  throw new Error('Missing Wasm placeholder: rebuild init-base64.js before embedding')
}

// Zopfli produces a smaller zlib stream with the same runtime Deflate decoder.
const result = Bun.spawnSync(
  ['zopfli', '--zlib', '--i15', '-c', './dist/sqlite3-emscripten.wasm'],
  {stderr: 'inherit'}
)
if (result.error) throw result.error
if (result.exitCode !== 0) {
  throw new Error(`Zopfli compression failed (exit ${result.exitCode})`)
}
await Bun.write(
  './dist/init-base64.js',
  source.replace('$SRC', result.stdout.toString('base64'))
)
