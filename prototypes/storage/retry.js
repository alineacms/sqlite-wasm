// Prototype 3's driver: runs each call on the synchronous build, and when a
// read misses a block (the VFS failed it with SQLITE_IOERR_READ and recorded
// the block), loads the missing blocks from IndexedDB and runs it again.
//
// A miss can roll back the open transaction, so the statements since BEGIN
// are kept and replayed when it did: every call inside a transaction must
// be safe to run again with the same result, which holds for the SQL these
// benchmarks send.
//
// Every block a call reads must be in memory at once for it to finish, so
// the cache stops evicting while a call is retried. A call's memory use is
// therefore bounded by what it reads, not by the cache size.

export function createRetryDriver(driver, store) {
  let journal = null // calls since BEGIN, while a transaction is open
  const stats = (store.stats.replays = 0, store.stats)
  const retry = async (run) => {
    let replay = false
    let lost = false // the transaction was rolled back and is not replayed yet
    try {
      for (;;) {
        try {
          // SQLite rolls back only the failed statement while it can; if
          // it rolled back the whole transaction, run it again
          if (replay && (lost || !driver.inTransaction())) {
            lost = true
            stats.replays++
            if (driver.inTransaction()) driver.exec('ROLLBACK')
            for (const step of journal) step()
            lost = false
          }
          return run()
        } catch (error) {
          if (!store.missing.size) throw error
          const missing = [...store.missing]
          store.missing.clear()
          store.pinned = true
          await store.fetch(missing)
          replay = journal !== null
        }
      }
    } finally {
      store.pinned = false
      store.evict()
    }
  }
  const call = async (run) => {
    const result = await retry(run)
    if (journal) journal.push(run)
    return result
  }
  return {
    open: (name) => retry(() => driver.open(name)),
    async exec(sql) {
      const verb = sql.trim().toUpperCase()
      if (verb === 'BEGIN') {
        await retry(() => driver.exec(sql))
        journal = [() => driver.exec(sql)]
        return
      }
      if (verb === 'COMMIT' || verb === 'ROLLBACK') {
        await retry(() => driver.exec(sql))
        journal = null
        return
      }
      return call(() => driver.exec(sql))
    },
    query: (sql, params) => call(() => driver.query(sql, params)),
    close: () => driver.close(),
  }
}
