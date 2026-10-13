// Full saves in place and compacted, of a database scattered by many
// saves, in a Worker (compact-worker.js), and reading each back in a new
// one. window.runCompactBenchmark() resolves to the results by variant.
// See script/test-browser.ts --compact and BENCHMARKS.md.
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
  const worker = new Worker('./compact-worker.js', {type: 'module'})
  try {
    return await call(worker, action, args)
  } finally {
    worker.terminate()
  }
}

window.runCompactBenchmark = async ({rounds = 60, readCache} = {}) => {
  const results = {userAgent: navigator.userAgent, variants: {}}
  for (const variant of ['indexeddb', 'opfs']) {
    await clearStorage()
    const saves = await inWorker('build', {variant, rounds, readCache})
    const reads = {}
    for (const key of ['inplace', 'compacted'])
      reads[key] = await inWorker('scan', {variant, key})
    results.variants[variant] = {saves, reads}
  }
  await clearStorage()
  return results
}
