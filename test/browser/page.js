// Browser tests for file storage in OPFS and databases shared between
// Workers, with real OPFS, Web Locks and BroadcastChannel. Every test starts
// its own Workers; window.runTests() runs them all and reports each.

class TestWorker {
  pending = new Map()
  nextId = 0

  constructor() {
    this.worker = new Worker('./worker.js', {type: 'module'})
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = event => reject(new Error(event.message))
      this.worker.onmessage = ({data}) => {
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
      this.worker.postMessage({id, action, args})
    })
  }

  // Like closing the tab: nothing is closed or flushed.
  terminate() {
    this.worker.terminate()
  }
}

const workers = []
const spawn = () => {
  const worker = new TestWorker()
  workers.push(worker)
  return worker
}

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

  async 'shares a database between Workers and hands it over'() {
    const a = spawn()
    const b = spawn()
    const c = spawn()
    for (const worker of [a, b, c]) {
      await worker.call('share', {name: 'shared', file: 'shared.sqlite3'})
    }
    await a.call('sharedExec', {sql: 'create table if not exists t (x)'})
    await until(() => a.call('owner'), 'first Worker owns it')
    await b.call('sharedTransaction', {
      statements: [['insert into t values (?)', [1]], ['insert into t values (?)', [2]]]
    })
    same(await c.call('sharedQuery', {sql: 'select sum(x) as s from t'}), [{s: 3}], 'relayed')
    a.terminate()
    same(
      await c.call('sharedQuery', {sql: 'select count(*) as n from t'}),
      [{n: 2}],
      'after the owner went away'
    )
    const owners = [await b.call('owner'), await c.call('owner')]
    same(owners.filter(Boolean).length, 1, 'one new owner')
    await b.call('sharedClose')
    same(await c.call('sharedQuery', {sql: 'select 1 as one'}), [{one: 1}], 'handed over again')
    await c.call('sharedClose')
  }
}

window.runTests = async () => {
  const root = await navigator.storage.getDirectory()
  const results = []
  for (const [name, test] of Object.entries(tests)) {
    for await (const key of root.keys()) await root.removeEntry(key)
    const start = performance.now()
    try {
      await test()
      results.push({name, ok: true, ms: performance.now() - start})
    } catch (error) {
      results.push({name, ok: false, error: String(error?.stack ?? error)})
    }
    for (const worker of workers.splice(0)) worker.terminate()
    // Let terminated Workers release their files and locks.
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return results
}
