// Workers the browser tests and benchmarks drive: each call names an
// action of the Worker's script and resolves to its result.

let sharedWorkers = 0

export class TestWorker {
  pending = new Map()
  nextId = 0

  // kind: 'file', a dedicated Worker running worker.js (file storage);
  // 'shared', a new SharedWorker running snapshot-worker.js; 'dedicated',
  // a dedicated Worker running snapshot-worker.js.
  constructor(kind = 'file') {
    this.ready = new Promise((resolve, reject) => {
      this.fail = reject
      if (kind === 'shared') {
        const worker = new SharedWorker('./snapshot-worker.js', {
          type: 'module',
          name: `snapshots-${sharedWorkers++}`
        })
        this.port = worker.port
        worker.onerror = event =>
          this.failAll(new Error(`SharedWorker failed: ${event.message ?? 'error'}`))
      } else {
        const script = kind === 'file' ? './worker.js' : './snapshot-worker.js'
        this.worker = new Worker(script, {type: 'module'})
        this.port = this.worker
        this.worker.onerror = event =>
          this.failAll(new Error(`Worker failed: ${event.message ?? 'error'}`))
      }
      this.port.onmessage = ({data}) => {
        if (data.ready) return resolve()
        const {resolve: done, reject: fail} = this.pending.get(data.id)
        this.pending.delete(data.id)
        if (data.error) fail(Object.assign(new Error(data.error.message), data.error))
        else done(data.result)
      }
      this.port.start?.()
    })
  }

  failAll(error) {
    this.fail(error)
    for (const {reject} of this.pending.values()) reject(error)
    this.pending.clear()
  }

  /** Call `action`, failing after `timeout` milliseconds if given. */
  async call(action, args, timeout) {
    const call = this.ready.then(() => {
      const id = this.nextId++
      return new Promise((resolve, reject) => {
        this.pending.set(id, {resolve, reject})
        this.port.postMessage({id, action, args})
      })
    })
    if (!timeout) return call
    let timer
    return Promise.race([
      call,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${action} timed out after ${timeout} ms`)),
          timeout
        )
      })
    ]).finally(() => clearTimeout(timer))
  }

  // Like closing the tab: nothing is closed or flushed. SharedWorkers
  // live on while the page does; they are only disconnected.
  terminate() {
    if (this.worker) this.worker.terminate()
    else this.port.close()
  }
}

const workers = []

export function spawn(kind) {
  const worker = new TestWorker(kind)
  workers.push(worker)
  return worker
}

export function terminateAll() {
  for (const worker of workers.splice(0)) worker.terminate()
}

/** Remove everything OPFS and IndexedDB hold for this origin. */
export async function clearStorage() {
  const root = await navigator.storage.getDirectory()
  for await (const key of root.keys()) await root.removeEntry(key, {recursive: true})
  for (const {name} of (await indexedDB.databases?.()) ?? []) {
    await new Promise(resolve => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = req.onerror = req.onblocked = resolve
    })
  }
}
