import factory from '../proto/dist/sync/sqlite.mjs'
import {createDriver} from '../proto/driver.js'
import {createRetryBackend} from '../proto/idb.js'
import {createRetryDriver} from '../proto/retry.js'
import {CACHE_BLOCKS, serveDriver} from './workers.js'

// Prototype 3: IndexedDB with retry on a missing block. Commits are stored
// in the background, so every call awaits flush(), as for the in-memory
// alinea engine.
serveDriver(async (database) => {
  const module = await factory()
  const name = `${database}.sqlite3`
  const store = await createRetryBackend(module, name, {cacheBlocks: CACHE_BLOCKS})
  const raw = createDriver(module)
  const driver = createRetryDriver(raw, store)
  const open = driver.open
  driver.open = async () => {
    const version = await open(name)
    await driver.exec('PRAGMA journal_mode=MEMORY')
    return version
  }
  return {driver, flush: () => store.flush(), close: () => store.close()}
})
