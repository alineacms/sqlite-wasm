import fs from 'fs'

const source = fs.readFileSync('./dist/sqlite3-emscripten.js', 'utf-8')
if (!source.startsWith('import'))
  fs.writeFileSync(
    './dist/sqlite3-emscripten.js',
    `import {createRequire} from 'module'\n` +
      `const require = createRequire(import.meta.url)\n` +
      source
  )
