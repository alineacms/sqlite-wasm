# @alinea/sqlite-wasm

SQLite compiled to WebAssembly for browsers, workers, edge runtimes, Node.js,
and Bun. The package exposes a small `sql.js`-compatible database API and ships
both a deflate-compressed Base64 build and a separate Wasm build.

```ts
import {init} from '@alinea/sqlite-wasm'

const {Database} = await init()
const db = new Database()
db.run('create table messages (text)')
db.run('insert into messages values (?)', ['hello'])
console.log(db.exec('select * from messages'))
db.close()
```

The build includes SQLite JSON functions, FTS5, views, triggers, window
functions, temporary tables, `VACUUM`, and `ATTACH` for additional in-memory
databases. Databases live in memory;
use `db.export()` and `new Database(bytes)` to persist and restore their file
representation.

This is deliberately a size-oriented SQLite build. Date/time functions,
`EXPLAIN`, `ALTER TABLE`, and `ANALYZE` are omitted. The complete compile-time
option list is kept in the `SQLITE_OMIT_FLAGS` variable in the Makefile.

## Development

Open the repository in its VS Code devcontainer, then run:

```sh
bun install --frozen-lockfile
bun run build
bun test
```

The toolchain is pinned in the devcontainer and package manifest. The build
uses SQLite's in-memory pager with a minimal VFS, so it does not ship
Emscripten's JavaScript filesystem implementation. The Makefile downloads and
checksums SQLite's canonical source archive, applies the small compatibility
patch needed by this feature set, and generates the custom amalgamation before
compiling it.

Forked from [kbumsik/sqlite-wasm](https://github.com/kbumsik/sqlite-wasm).
