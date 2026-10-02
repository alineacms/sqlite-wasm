import {init} from '@alinea/sqlite-wasm';
import {indexedDBStorage} from '@alinea/sqlite-wasm/indexeddb';
import {serve} from './rpc.js';

// @alinea/sqlite-wasm runs queries on an in-memory copy and writes each
// commit's changed pages to IndexedDB in the background. To keep the other
// engines' default durability, every call awaits flush(), so a statement only
// returns once every commit so far is stored. Inside a transaction there is
// nothing to flush until COMMIT.
let db;
const statements = new Map();
const durable = (result) => db.flush().then(() => result);

serve({
  async open({storage, database}) {
    const {Database} = await init();
    db = storage === 'opfs' ? await Database.sync(indexedDBStorage(database)) : new Database();
    const [{v}] = [...each('SELECT sqlite_version() AS v')];
    return {engineVersion: v};
  },
  exec({sql}) {
    db.run(sql);
    return durable();
  },
  // Statements are cached by SQL text, as in the SQLite adapter. $n
  // placeholders become SQLite's ?n form.
  query({sql, params}) {
    return durable([...each(sql, params)]);
  },
  async close() {
    for (const statement of statements.values()) statement.free();
    statements.clear();
    db.close();
    await db.flush();
  },
});

function* each(sql, params) {
  let statement = statements.get(sql);
  if (statement == null) {
    statement = db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    statements.set(sql, statement);
  }
  try {
    if (params?.length) statement.bind(params);
    while (statement.step()) yield statement.getAsObject();
  } finally {
    statement.reset();
  }
}
