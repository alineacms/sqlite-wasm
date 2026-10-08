// Benchmarks of snapshot storage with bases in OPFS and in IndexedDB, on
// the content database of bench-data.js (20,000 entries, about 50 MB, 64 KB
// pages). window.runBenchmarks({seconds}) runs them and resolves to the
// results by variant; a step that fails records its error and the others
// still run. See script/test-browser.ts --bench and BENCHMARKS.md.
import {clearStorage, spawn, terminateAll} from './workers.js'

const VARIANTS = ['opfs', 'indexeddb']
const LONG = 10 * 60_000

async function step(results, name, run) {
  try {
    results[name] = await run()
  } catch (error) {
    results[name] = {error: String(error?.message ?? error)}
  }
}

async function benchmark(variant, seconds) {
  const results = {}
  const storage = `bench-${variant}`

  // 1. The first base, from a database built in memory
  const builder = spawn('shared')
  await step(results, 'firstBase', () =>
    builder.call('benchFirstBase', {variant, storage, key: 'base-0'}, LONG)
  )
  await builder.call('close').catch(() => {})

  // 2. Opening an overlay over it, to the first query, in a new Worker
  const reader = spawn('shared')
  await step(results, 'open', () =>
    reader.call('open', {variant, storage, base: 'base-0', query: true}, LONG)
  )

  // 3. Queries, cold (fresh fork) and warm
  await step(results, 'queries', () => reader.call('benchQueries', {}, LONG))
  // The same with a page cache that holds the whole database
  await step(results, 'queriesLargeCache', () =>
    reader.call('benchQueries', {cacheKiB: 65536}, LONG)
  )

  // 4. Checkpoints after 10, 1,000 and 20,000 changed rows
  results.checkpoints = {}
  for (const [count, version] of [[10, 1], [1000, 2], [20_000, 3]]) {
    await step(results.checkpoints, count, () =>
      reader.call('benchCheckpoint', {count, version, key: `changed-${count}`}, LONG)
    )
  }

  // 5. Two SharedWorkers on one base for `seconds`: one writes and
  // checkpoints in a loop, the other reads and writes its own overlay.
  await step(results, 'twoWorkers', async () => {
    const twoStorage = `bench-${variant}-two`
    const writer = spawn('shared')
    await writer.call('benchFirstBase', {variant, storage: twoStorage, key: 'v1'}, LONG)
    const other = spawn('shared')
    await other.call('open', {variant, storage: twoStorage, base: 'v1'}, LONG)
    const [written, read] = await Promise.all([
      writer.call('writerLoop', {seconds}, LONG),
      other.call('readerLoop', {seconds}, LONG)
    ])
    const checker = spawn('shared')
    const opened = await checker.call('open', {variant, storage: twoStorage}, LONG)
    const [[logged]] = await checker.call('rows', {sql: 'select count(*) from log'})
    await writer.call('cleanup')
    const list = await writer.call('list')
    const bases = list.map(base => base.key)
    // The newest and the snapshots it lies over are kept; with locks
    // (OPFS), also v1, which the reader reads.
    const parents = new Map(list.map(base => [base.key, base.parent]))
    const expected = new Set(variant === 'opfs' ? ['v1'] : [])
    for (let key = written.base; key !== undefined; key = parents.get(key))
      expected.add(key)
    await Promise.all([writer, other, checker].map(w => w.call('close').catch(() => {})))
    const ok =
      opened.base === written.base &&
      logged === written.checkpoints &&
      bases.length === expected.size &&
      bases.every(key => expected.has(key))
    return {
      seconds,
      checkpoints: written.checkpoints,
      readerRounds: read.rounds,
      bases: bases.length,
      expectedBases: expected.size,
      ok
    }
  })

  // 6. Reading a base whose stored entry was deleted while it was open
  const deleted = spawn('shared')
  await step(results, 'deletedRead', async () => {
    await deleted.call('open', {variant, storage, base: 'changed-20000'}, LONG)
    return deleted.call('benchDeletedRead', {}, LONG)
  })
  await reader.call('close').catch(() => {})
  await deleted.call('close').catch(() => {})
  return results
}

// 7. Whether each variant works in a SharedWorker and a dedicated Worker
async function support() {
  const out = {}
  for (const kind of ['shared', 'dedicated']) {
    for (const variant of VARIANTS) {
      const name = `${kind} ${variant}`
      try {
        const worker = spawn(kind)
        out[name] = await worker.call(
          'support',
          {variant, storage: `support-${kind}-${variant}`},
          60_000
        )
      } catch (error) {
        out[name] = {ok: false, error: String(error?.message ?? error)}
      }
    }
  }
  return out
}

window.runBenchmarks = async ({seconds = 30} = {}) => {
  const results = {userAgent: navigator.userAgent, variants: {}}
  await clearStorage()
  results.support = await support()
  terminateAll()
  for (const variant of VARIANTS) {
    await clearStorage()
    results.variants[variant] = await benchmark(variant, seconds)
    terminateAll()
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await clearStorage()
  return results
}
