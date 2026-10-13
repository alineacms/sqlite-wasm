// Full-text search on the database of fts-data.js stored as a snapshot (a
// Blob in IndexedDB) and as an OPFS file, fresh, scattered by changes all
// over, and vacuumed after those, each read by a new dedicated Worker
// (storage-worker.js), a few times. window.runStorageBenchmark() resolves
// to the results. See script/test-browser.ts --storage and BENCHMARKS.md.
import {clearStorage} from './workers.js'

function call(worker, action, args) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({data}) =>
      data.error ? reject(new Error(data.error)) : resolve(data.result)
    worker.onerror = event =>
      reject(new Error(`Worker failed: ${event.message ?? 'error'}`))
    worker.postMessage({id: 0, action, args})
  })
}

async function inWorker(action, args) {
  const worker = new Worker('./storage-worker.js', {type: 'module'})
  try {
    return await call(worker, action, args)
  } finally {
    worker.terminate()
  }
}

window.runStorageBenchmark = async ({rounds = 100, runs = 3} = {}) => {
  await clearStorage()
  const results = {userAgent: navigator.userAgent}
  results.prepared = await inWorker('prepare', {rounds})
  results.queries = {}
  for (const name of ['fresh', 'scattered', 'vacuumed'])
    for (const store of ['snapshot', 'file']) {
      const runsOf = []
      for (let run = 0; run < runs; run++) runsOf.push(await inWorker('query', {store, name}))
      results.queries[`${name} ${store}`] = runsOf
    }
  results.locks = await inWorker('locks', {})
  await clearStorage()
  return results
}
