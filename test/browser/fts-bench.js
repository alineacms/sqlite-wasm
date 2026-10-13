// Full-text search on a snapshot in IndexedDB, in a Worker (fts-worker.js):
// window.runFtsBenchmark() builds the database in one Worker, then opens it
// in new ones and times searches, a few times. See script/test-browser.ts
// --fts and BENCHMARKS.md.
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

window.runFtsBenchmark = async ({runs = 3, readCache} = {}) => {
  await clearStorage()
  const builder = new Worker('./fts-worker.js', {type: 'module'})
  const database = await call(builder, 'build')
  builder.terminate()
  const queries = []
  for (let run = 0; run < runs; run++) {
    const worker = new Worker('./fts-worker.js', {type: 'module'})
    queries.push(await call(worker, 'query', {readCache}))
    worker.terminate()
  }
  await clearStorage()
  return {userAgent: navigator.userAgent, database, queries}
}
