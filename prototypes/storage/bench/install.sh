#!/bin/bash
# Adds the three prototypes to TinyJoin's comparative benchmark checkout
# ($1, default /home/user/tinyplex/tinyjoin) as engines proto-opfs,
# proto-jspi and proto-retry, plus the package itself (in memory, stored in
# IndexedDB) as alinea, which also needs `npm install @alinea/sqlite-wasm`
# in benchmarks/compare. Build the prototypes first (../build.sh).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
compare=${1:-/home/user/tinyplex/tinyjoin}/benchmarks/compare
engines=$compare/app/engines
rm -rf "$engines/proto" "$engines/bench"
mkdir -p "$engines/proto/dist" "$engines/bench"
cp "$here"/../*.js "$engines/proto/"
cp -r "$here"/../dist/sync "$here"/../dist/jspi "$engines/proto/dist/"
cp "$here"/*.js "$engines/bench/"
mv "$engines/bench/alinea.js" "$engines/bench/alinea-worker.js" \
  "$engines/bench/alinea-opfs.js" "$engines/bench/alinea-opfs-worker.js" "$engines/"
python3 - "$compare" <<'PY'
import sys
compare = sys.argv[1]
names = ['opfs', 'jspi', 'retry']
p = f'{compare}/app/harness.js'
s = open(p).read()
if "alinea:" not in s:
    s = s.replace("  pglite: () => import('./engines/pglite.js'),\n", "  pglite: () => import('./engines/pglite.js'),\n  alinea: () => import('./engines/alinea.js'),\n")
if "'alinea-opfs'" not in s:
    s = s.replace("  alinea: () => import('./engines/alinea.js'),\n", "  alinea: () => import('./engines/alinea.js'),\n  'alinea-opfs': () => import('./engines/alinea-opfs.js'),\n")
if 'proto-opfs' not in s:
    entries = ''.join(f"  'proto-{n}': () => import('./engines/bench/{n}.js'),\n" for n in names)
    s = s.replace('const engines = {\n', 'const engines = {\n' + entries)
    open(p, 'w').write(s)
p = f'{compare}/run.mjs'
s = open(p).read()
if "'alinea'" not in s:
    s = s.replace("'pglite'];", "'pglite', 'alinea'];")
    s = s.replace("pglite: '@electric-sql/pglite'};", "pglite: '@electric-sql/pglite', alinea: '@alinea/sqlite-wasm'};")
    s = s.replace("pglite: 'opfs-ahp://'},", "pglite: 'opfs-ahp://', alinea: 'indexeddb'},")
    s = s.replace("pglite: 'memory://'},", "pglite: 'memory://', alinea: 'memory'},")
if "'alinea-opfs'" not in s:
    s = s.replace("'alinea'];", "'alinea', 'alinea-opfs'];")
    s = s.replace("alinea: '@alinea/sqlite-wasm'};", "alinea: '@alinea/sqlite-wasm', 'alinea-opfs': '@alinea/sqlite-wasm'};")
    s = s.replace("alinea: 'indexeddb'},", "alinea: 'indexeddb', 'alinea-opfs': 'opfs, page cache only'},")
if 'proto-opfs' not in s:
    # Appended: run.mjs installs every engine after the first from npm
    s = s.replace("'alinea-opfs'];", "'alinea-opfs', " + ', '.join(f"'proto-{n}'" for n in names) + "];")
    s = s.replace("'alinea-opfs': '@alinea/sqlite-wasm'};", "'alinea-opfs': '@alinea/sqlite-wasm', " + ''.join(f"'proto-{n}': '@alinea/sqlite-wasm', " for n in names) + "};")
    storage = {'opfs': 'opfs sync access handles', 'jspi': 'indexeddb via JSPI', 'retry': 'indexeddb, retry on miss'}
    s = s.replace("  opfs: {", "  opfs: {" + ''.join(f"'proto-{n}': '{storage[n]}', " for n in names))
open(p, 'w').write(s)
PY
echo "installed into $engines"
