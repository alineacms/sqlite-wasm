import factory from '../proto/dist/sync/sqlite.mjs'
import {createDriver} from '../proto/driver.js'
import {createOPFSBackend} from '../proto/opfs.js'
import {serveDriver} from './workers.js'

// Prototype 1: sync access handles, default rollback journal.
serveDriver(async (database) => {
  const module = await factory()
  const backend = await createOPFSBackend(module, `${database}.sqlite3`)
  const driver = createDriver(module)
  const open = driver.open
  driver.open = () => open(`${database}.sqlite3`)
  return {driver, flush: backend.flush, close: backend.close}
})
