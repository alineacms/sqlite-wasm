// Browser tests for file and snapshot storage in OPFS, with real OPFS, Web
// Locks, Workers and SharedWorkers. Every test starts its own Workers;
// window.runTests() runs them all and reports each.

let sharedWorkers = 0

class TestWorker {
  pending = new Map()
  nextId = 0

  // A dedicated Worker running worker.js, or with shared, a new
  // SharedWorker running snapshot-worker.js.
  constructor(shared = false) {
    if (shared) {
      const worker = new SharedWorker('./snapshot-worker.js', {
        type: 'module',
        name: `snapshots-${sharedWorkers++}`
      })
      this.port = worker.port
      this.port.start()
      worker.onerror = event => console.error('SharedWorker error', event.message)
    } else {
      this.worker = new Worker('./worker.js', {type: 'module'})
      this.port = this.worker
    }
    this.ready = new Promise((resolve, reject) => {
      if (this.worker) this.worker.onerror = event => reject(new Error(event.message))
      this.port.onmessage = ({data}) => {
        if (data.ready) return resolve()
        const {resolve: done, reject: fail} = this.pending.get(data.id)
        this.pending.delete(data.id)
        if (data.error) fail(Object.assign(new Error(data.error.message), data.error))
        else done(data.result)
      }
    })
  }

  async call(action, args) {
    await this.ready
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject})
      this.port.postMessage({id, action, args})
    })
  }

  // Like closing the tab: nothing is closed or flushed. SharedWorkers
  // live on while the page does; they are only disconnected.
  terminate() {
    if (this.worker) this.worker.terminate()
    else this.port.close()
  }
}

const workers = []
const spawn = (shared = false) => {
  const worker = new TestWorker(shared)
  workers.push(worker)
  return worker
}
const spawnShared = () => spawn(true)

// Measurements, reported with the test that made them
let notes = []
const note = text => notes.push(text)
const mb = bytes => (bytes / 1e6).toFixed(1)

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
    const a = spawn()
    await a.call('open', {file: 'store.sqlite3'})
    await a.call('fill', {count: 5000, size: 400})
    same(await a.call('rows', {sql: 'pragma overlay_pages'}), [['0']], 'pages held')
    assert(await a.call('size', {file: 'store.sqlite3'}) > 2_000_000, 'file size')
    await a.call('close')
    const b = spawn()
    await b.call('open', {file: 'store.sqlite3'})
    same(
      await b.call('rows', {sql: 'select count(*), sum(length(body)) from items'}),
      [[5000, 2_000_000]],
      'reopened'
    )
    await b.call('close')
  },

  async 'keeps commits when the Worker is terminated'() {
    const a = spawn()
    await a.call('open', {file: 'crash.sqlite3'})
    await a.call('fill', {count: 100, size: 100})
    await a.call('run', {sql: 'delete from items where id > 10'})
    a.terminate()
    const b = spawn()
    // The handle is released when the Worker is gone.
    await until(
      () => b.call('open', {file: 'crash.sqlite3'}).then(() => true, () => false),
      'reopen after terminate'
    )
    same(await b.call('rows', {sql: 'select count(*) from items'}), [[10]], 'rows')
    await b.call('close')
  },

  async 'allows one Worker per file'() {
    const a = spawn()
    const b = spawn()
    await a.call('open', {file: 'busy.sqlite3'})
    await rejects(b.call('open', {file: 'busy.sqlite3'}), 'SQLITE_BUSY', 'second Worker')
    await a.call('close')
    await b.call('open', {file: 'busy.sqlite3'})
    await b.call('close')
  },

  async 'attaches, forks and detaches'() {
    const a = spawn()
    await a.call('memory')
    await a.call('fill', {count: 1000, size: 200})
    await a.call('attach', {file: 'attach.sqlite3'})
    same(await a.call('rows', {sql: 'pragma overlay_pages'}), [['0']], 'attached')
    await a.call('detach')
    await a.call('run', {sql: 'delete from items'})
    await a.call('fork')
    same(await a.call('rows', {sql: 'select count(*) from items'}), [[0]], 'fork')
    const b = spawn()
    await b.call('open', {file: 'attach.sqlite3'})
    same(await b.call('rows', {sql: 'select count(*) from items'}), [[1000]], 'stored')
    await b.call('close')
  },

  async 'snapshot storage works in SharedWorkers'() {
    const a = spawnShared()
    same(await a.call('supported'), true, 'supported')
  },

  async 'two SharedWorkers share a base while one checkpoints'() {
    const storage = 'two-workers'
    const a = spawnShared()
    same(await a.call('open', {storage, pageSize: 65536}), null, 'starts empty')
    await a.call('fill', {count: 4000, size: 1000})
    same((await a.call('checkpoint', {name: 'v1'})).written, true, 'v1 written')
    const b = spawnShared()
    same(await b.call('open', {storage}), 'v1', 'b opens the newest')

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
    same(await a.call('rows', {sql: "pragma overlay_pages"}), [['0']], 'a holds no pages')

    // b keeps v1 and its changes; a new Worker opens v2.
    same(
      await b.call('rows', {sql: 'select count(*), sum(n) from items'}),
      [[4000, 200]],
      'b'
    )
    const c = spawnShared()
    same(await c.call('open', {storage}), 'v2', 'c opens the newest')
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
    same(await d.call('open', {storage}), 'b1', 'd opens the newest')
    same(await d.call('rows', {sql: 'select sum(n) from items'}), [[200]], 'd')
    // Nobody reads v1 anymore; a reads v2 and c, d read the others.
    same(await a.call('cleanup'), ['v1'], 'cleanup')
    await c.call('close')
    same(await a.call('cleanup'), [], 'a still reads v2')
  },

  async 'measures reads and a 50 MB checkpoint'() {
    const storage = 'measure'
    const a = spawnShared()
    await a.call('open', {storage, pageSize: 65536})
    await a.call('fill', {count: 50_000, size: 1000})
    const first = await a.call('checkpoint', {name: 'big'})
    const b = spawnShared()
    await b.call('open', {storage, base: 'big'})
    const scan = await b.call('scan')
    same(scan.bytes, 50_000_000, 'scanned')
    const size = scan.pageSize * scan.pages
    note(
      `read ${scan.pages} pages of ${scan.pageSize / 1024} KB (${mb(size)} MB) in ` +
      `${scan.ms.toFixed(0)} ms: ${(scan.ms / scan.pages).toFixed(2)} ms per page, ` +
      `${mb(size / (scan.ms / 1000))} MB/s`
    )
    const raw = await b.call('rawScan', {pageSize: scan.pageSize})
    note(
      `FileReaderSync alone: ${raw.reads} reads in ${raw.ms.toFixed(0)} ms, ` +
      `${(raw.ms / raw.reads).toFixed(2)} ms per read`
    )
    note(`first checkpoint, ${mb(size)} MB from memory: ${first.ms.toFixed(0)} ms`)
    await b.call('run', {sql: 'update items set n = 1 where id % 1000 = 0'})
    const next = await b.call('checkpoint', {name: 'big2'})
    same(next.written, true, 'big2 written')
    note(`checkpoint of ${mb(size)} MB copying the base, 50 pages changed: ${next.ms.toFixed(0)} ms`)
    const c = spawnShared()
    await c.call('open', {storage, base: 'big2'})
    same(
      await c.call('rows', {sql: 'select count(*), sum(n), sum(length(body)) from items'}),
      [[50_000, 50, 50_000_000]],
      'reopened'
    )
  }
}

window.runTests = async () => {
  const root = await navigator.storage.getDirectory()
  const results = []
  for (const [name, test] of Object.entries(tests)) {
    for await (const key of root.keys()) await root.removeEntry(key, {recursive: true})
    notes = []
    const start = performance.now()
    try {
      await test()
      results.push({name, ok: true, ms: performance.now() - start, notes})
    } catch (error) {
      results.push({name, ok: false, error: String(error?.stack ?? error)})
    }
    for (const worker of workers.splice(0)) worker.terminate()
    // Let terminated Workers release their files and locks.
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return results
}
