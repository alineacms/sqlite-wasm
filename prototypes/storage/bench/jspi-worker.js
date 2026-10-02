import factory from '../proto/dist/jspi/sqlite.mjs'
import {createAsyncDriver} from '../proto/driver.js'
import {createJSPIBackend} from '../proto/idb.js'
import {CACHE_BLOCKS, serveDriver} from './workers.js'

// Prototype 2: IndexedDB awaited through JSPI. Each sync waits for its
// IndexedDB transaction, so there is nothing left to flush.
serveDriver(async (database) => {
  const module = await factory()
  const name = `${database}.sqlite3`
  const store = await createJSPIBackend(module, name, {cacheBlocks: CACHE_BLOCKS})
  const driver = createAsyncDriver(module)
  const open = driver.open
  driver.open = async () => {
    const version = await open(name)
    await driver.exec('PRAGMA journal_mode=MEMORY')
    return version
  }
  return {driver, flush: () => store.flush(), close: () => store.close()}
})
