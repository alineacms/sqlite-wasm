// Shared by the three prototype Workers in the TinyJoin comparative
// benchmark: serve() answers the harness's open/exec/query/close messages.
// Every engine keeps SQLite's page cache at its default 256 KiB, and the
// IndexedDB engines keep at most CACHE_BLOCKS 4 KiB blocks of the file in
// memory, less than the benchmark databases, so all of them read from
// storage. A call returns once its commits are stored.
import {serve} from '../rpc.js'

export const CACHE_BLOCKS = 64

export function serveDriver(setup) {
  let session
  serve({
    async open({database}) {
      session = await setup(database)
      return {engineVersion: await session.driver.open(database)}
    },
    async exec({sql}) {
      await session.driver.exec(sql)
      await session.flush()
    },
    async query({sql, params}) {
      const rows = await session.driver.query(sql, params)
      await session.flush()
      return rows
    },
    async close() {
      await session.driver.close()
      await session.flush()
      session.close()
    },
  })
}
