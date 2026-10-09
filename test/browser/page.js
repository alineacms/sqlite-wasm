// Browser tests for file and snapshot storage, with real OPFS, IndexedDB,
// Web Locks, Workers and SharedWorkers. Every test starts its own Workers;
// window.runTests() runs them all and reports each.
import {clearStorage, spawn, terminateAll} from './workers.js'

const spawnShared = () => spawn('shared')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function same(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${message}: expected ${b}, got ${a}`)
}

async function rejects(promise, code, message) {
  try {
    await promise
  } catch (error) {
    same(error.code, code, message)
    return
  }
  throw new Error(`${message}: did not fail`)
}

const until = async (condition, message) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out: ${message}`)
}

const tests = {
  async 'stores commits in OPFS and opens them in another Worker'() {
    const a = spawn('file')
    await a.call('open', {file: 'store.sqlite3'})
    await a.call('fill', {count: 5000, size: 400})
    same(await a.call('rows', {sql: 'pragma overlay_pages'}), [['0']], 'pages held')
    assert(await a.call('size', {file: 'store.sqlite3'}) > 2_000_000, 'file size')
    await a.call('close')
    const b = spawn('file')
    await b.call('open', {file: 'store.sqlite3'})
    same(
      await b.call('rows', {sql: 'select count(*), sum(length(body)) from items'}),
      [[5000, 2_000_000]],
      'reopened'
    )
    await b.call('close')
  },

  async 'keeps commits when the Worker is terminated'() {
    const a = spawn('file')
    await a.call('open', {file: 'crash.sqlite3'})
    await a.call('fill', {count: 100, size: 100})
    await a.call('run', {sql: 'delete from items where id > 10'})
    a.terminate()
    const b = spawn('file')
    // The handle is released when the Worker is gone.
    await until(
      () => b.call('open', {file: 'crash.sqlite3'}).then(() => true, () => false),
      'reopen after terminate'
    )
    same(await b.call('rows', {sql: 'select count(*) from items'}), [[10]], 'rows')
    await b.call('close')
  },

  async 'allows one Worker per file'() {
    const a = spawn('file')
    const b = spawn('file')
    await a.call('open', {file: 'busy.sqlite3'})
    await rejects(b.call('open', {file: 'busy.sqlite3'}), 'SQLITE_BUSY', 'second Worker')
    await a.call('close')
    await b.call('open', {file: 'busy.sqlite3'})
    await b.call('close')
  },

  async 'attaches, forks and detaches'() {
    const a = spawn('file')
    await a.call('memory')
    await a.call('fill', {count: 1000, size: 200})
    await a.call('attach', {file: 'attach.sqlite3'})
    same(await a.call('rows', {sql: 'pragma overlay_pages'}), [['0']], 'attached')
    await a.call('detach')
    await a.call('run', {sql: 'delete from items'})
    await a.call('fork')
    same(await a.call('rows', {sql: 'select count(*) from items'}), [[0]], 'fork')
    const b = spawn('file')
    await b.call('open', {file: 'attach.sqlite3'})
    same(await b.call('rows', {sql: 'select count(*) from items'}), [[1000]], 'stored')
    await b.call('close')
  },

  async 'snapshot storage works in SharedWorkers'() {
    const a = spawnShared()
    same(await a.call('supported', {variant: 'opfs'}), true, 'OPFS')
    same(await a.call('supported', {variant: 'indexeddb'}), true, 'IndexedDB')
  }
}

// Two SharedWorkers on one base, one checkpointing while the other reads
// and writes its own overlay, with bases in OPFS (which holds locks on the
// bases Workers read) or IndexedDB (which needs none).
for (const variant of ['opfs', 'indexeddb']) {
  tests[`two SharedWorkers share a base while one checkpoints (${variant})`] =
    async () => {
      const storage = 'two-workers'
      const open = async (worker, args) =>
        (await worker.call('open', {variant, storage, ...args})).base
      const a = spawnShared()
      same(await open(a, {pageSize: 65536}), null, 'starts empty')
      await a.call('fill', {count: 4000, size: 1000})
      same((await a.call('checkpoint', {name: 'v1'})).written, true, 'v1 written')
      const b = spawnShared()
      same(await open(b), 'v1', 'b opens the newest')

      // a changes and checkpoints a much larger database, while b keeps
      // reading every row of v1 and writing its own changes.
      await a.call('fill', {count: 20_000, size: 1000, from: 4000})
      await a.call('run', {sql: 'update items set n = 1 where id % 2 = 0'})
      const churn = b.call('churn', {rounds: 200})
      const checkpoint = a.call('checkpoint', {name: 'v2'})
      const [bSum, {written}] = await Promise.all([churn, checkpoint])
      same(written, true, 'v2 written')
      same(bSum, 200, "b's changes")
      same(await a.call('base'), 'v2', 'a moved to v2')
      same(await a.call('rows', {sql: 'pragma overlay_pages'}), [['0']], 'a holds no pages')

      // b keeps v1 and its changes; a new Worker opens v2.
      same(
        await b.call('rows', {sql: 'select count(*), sum(n) from items'}),
        [[4000, 200]],
        'b'
      )
      const c = spawnShared()
      same(await open(c), 'v2', 'c opens the newest')
      same(
        await c.call('rows', {sql: 'select count(*), sum(n), sum(length(body)) from items'}),
        [[24_000, 12_000, 24_000_000]],
        'c'
      )
      // b's later changes survive its own checkpoint, which is now newest.
      same((await b.call('checkpoint', {name: 'b1'})).written, true, 'b1 written')
      await b.call('churn', {rounds: 3})
      same(await b.call('rows', {sql: 'select sum(n) from items'}), [[203]], 'b after')
      const d = spawnShared()
      same(await open(d), 'b1', 'd opens the newest')
      same(await d.call('rows', {sql: 'select sum(n) from items'}), [[200]], 'd')
      // Nobody reads v1 anymore. With locks, cleanup keeps v2, which a
      // reads; IndexedDB deletes it, and a keeps reading it.
      if (variant === 'opfs') {
        same(await a.call('cleanup'), ['v1'], 'cleanup')
        same(await a.call('cleanup'), [], 'a still reads v2')
      } else {
        same((await a.call('cleanup')).sort(), ['v1', 'v2'], 'cleanup')
      }
      same(
        await a.call('rows', {sql: 'select count(*), sum(n) from items'}),
        [[24_000, 12_000]],
        'a reads v2'
      )
      same((await a.call('list')).map(base => base.key).sort(),
        variant === 'opfs' ? ['b1', 'v2'] : ['b1'], 'bases left')
    }
}

// Two SharedWorkers that make the same changes share the base the first
// writes: the second finds it written and reads it too.
for (const variant of ['opfs', 'indexeddb']) {
  tests[`two SharedWorkers with the same content share a base (${variant})`] =
    async () => {
      const storage = 'same-content'
      const workers = [spawnShared(), spawnShared()]
      for (const worker of workers) {
        await worker.call('open', {variant, storage})
        await worker.call('fill', {count: 2000, size: 1000})
      }
      const [a, b] = workers
      same((await a.call('checkpoint', {name: 'same'})).written, true, 'a')
      same((await b.call('checkpoint', {name: 'same'})).written, false, 'b')
      for (const worker of workers) {
        same(await worker.call('base'), 'same', 'base')
        same(
          await worker.call('rows', {sql: 'pragma overlay_pages'}),
          [['0']],
          'pages held'
        )
        same(
          await worker.call('rows', {
            sql: 'select count(*), sum(length(body)) from items'
          }),
          [[2000, 2_000_000]],
          'rows'
        )
      }
      same((await a.call('list')).map(base => base.key), ['same'], 'bases')
    }
}

// A full save over deltas keeps the pages it does not change from the
// snapshots below: a Worker that opens it later reads all of it. (WebKit
// stored such a Blob of over 32 MB wrongly in IndexedDB.)
for (const variant of ['opfs', 'indexeddb']) {
  tests[`a full save over deltas reads the same in another Worker (${variant})`] =
    async () => {
      const storage = 'full-over-delta'
      const a = spawnShared()
      await a.call('open', {variant, storage, pageSize: 65536})
      await a.call('fill', {count: 40_000, size: 1000})
      same((await a.call('checkpoint', {name: 'v0'})).written, true, 'v0 written')
      // Each changes rows all over: once the deltas add up to the size of
      // the database, the next is written in full.
      for (let k = 1; k <= 5; k++) {
        await a.call('run', {sql: `update items set n = n + 1 where id % 211 = ${k}`})
        same((await a.call('checkpoint', {name: `v${k}`})).written, true, `v${k} written`)
      }
      const parents = new Map(
        (await a.call('list')).map(({key, parent}) => [key, parent ?? null])
      )
      same(parents.get('v1'), 'v0', 'v1 is a delta')
      const full = [...parents].filter(([key, parent]) => key !== 'v0' && parent === null)
      assert(full.length > 0, 'a full save over deltas')
      await a.call('close')
      const b = spawnShared()
      same((await b.call('open', {variant, storage})).base, 'v5', 'b opens v5')
      same(
        await b.call('rows', {
          sql: "select count(*), sum(n), sum(length(body)) from items where substr(body, 1, length(id) + 1) = id || ' '"
        }),
        [[40_000, 5 * 190, 40_000_000]],
        'rows'
      )
      for (const [key] of full) {
        const c = spawnShared()
        await c.call('open', {variant, storage, base: key})
        const [[count, sum]] = await c.call('rows', {
          sql: "select count(*), sum(n) from items where substr(body, 1, length(id) + 1) = id || ' '"
        })
        same([count, sum], [40_000, Number(key.slice(1)) * 190], key)
      }
    }
}

window.runTests = async () => {
  const results = []
  for (const [name, test] of Object.entries(tests)) {
    await clearStorage()
    const start = performance.now()
    try {
      await test()
      results.push({name, ok: true, ms: performance.now() - start})
    } catch (error) {
      results.push({name, ok: false, error: `${error?.message ?? error}\n${error?.stack ?? ""}`})
    }
    terminateAll()
    // Let terminated Workers release their files and locks.
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return results
}
