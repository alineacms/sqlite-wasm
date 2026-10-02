import {init} from '@alinea/sqlite-wasm';
import {opfsStorage} from '@alinea/sqlite-wasm/opfs';
import {serve} from './rpc.js';

// @alinea/sqlite-wasm with OPFS storage: pages are read from the file as
// needed, and every commit is written to it (through the overlay's redo
// journal) before it returns, so flush() has nothing left to wait for.
let db;
const statements = new Map();
const durable = (result) => db.flush().then(() => result);

serve({
  async open({storage, database}) {
    const {Database} = await init();
    db = storage === 'opfs' ? await Database.sync(opfsStorage(`${database}.sqlite3`)) : new Database();
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
