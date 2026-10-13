// Runs test/browser in a headless browser: file and snapshot storage need a
// browser's OPFS, IndexedDB, Web Locks and Workers. Build first (bun run
// build).
//
//   bun script/test-browser.ts [--browser chromium|firefox|webkit]
//   bun script/test-browser.ts --bench [--seconds 30] [--out results.json]
//   bun script/test-browser.ts --fts [--runs 3] [--read-cache '{"blockSize": 65536}']
//   bun script/test-browser.ts --compact [--rounds 60]
//
// --bench runs the benchmarks of test/browser/bench.js instead of the tests,
// prints their results and writes them, with the machine and browser, to
// --out (default bench-results/<browser>.json); see BENCHMARKS.md. --fts
// times full-text searches on a snapshot in IndexedDB (test/browser/
// fts-bench.js), and --compact full saves in place and compacted
// (test/browser/compact-bench.js), and print the results. The
// browser build matching playwright-core must be installed (bunx
// playwright-core install chromium), or CHROMIUM_PATH, FIREFOX_PATH or
// WEBKIT_PATH set to another.
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {cpus, tmpdir, totalmem, type, release} from 'node:os'
import {dirname, join} from 'node:path'
import {parseArgs} from 'node:util'
import {chromium, firefox, webkit} from 'playwright-core'

const {values: args} = parseArgs({
  options: {
    browser: {type: 'string', default: 'chromium'},
    bench: {type: 'boolean', default: false},
    fts: {type: 'boolean', default: false},
    compact: {type: 'boolean', default: false},
    rounds: {type: 'string', default: '60'},
    runs: {type: 'string', default: '3'},
    'read-cache': {type: 'string'},
    seconds: {type: 'string', default: '30'},
    out: {type: 'string'}
  }
})
const browsers = {chromium, firefox, webkit}
const name = args.browser as keyof typeof browsers
if (!(name in browsers)) throw new Error(`Unknown browser ${name}`)

const out = await mkdtemp(join(tmpdir(), 'sqlite-wasm-browser-'))
const profile = await mkdtemp(join(tmpdir(), 'sqlite-wasm-profile-'))
const built = await Bun.build({
  entrypoints: [
    'test/browser/page.js',
    'test/browser/bench.js',
    'test/browser/fts-bench.js',
    'test/browser/fts-worker.js',
    'test/browser/compact-bench.js',
    'test/browser/compact-worker.js',
    'test/browser/worker.js',
    'test/browser/snapshot-worker.js'
  ],
  outdir: out,
  target: 'browser',
  format: 'esm'
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const {pathname} = new URL(request.url)
    const pages: Record<string, string> = {
      '/': './page.js',
      '/bench': './bench.js',
      '/fts': './fts-bench.js',
      '/compact': './compact-bench.js'
    }
    if (pathname in pages) {
      const script = pages[pathname]
      return new Response(`<!doctype html><script type="module" src="${script}"></script>`, {
        headers: {'content-type': 'text/html'}
      })
    }
    const file = Bun.file(join(out, pathname.slice(1)))
    if (!pathname.slice(1).includes('/') && (await file.exists())) {
      return new Response(file, {headers: {'content-type': 'text/javascript'}})
    }
    return new Response('Not found', {status: 404})
  }
})

let failed = 0
const context = await browsers[name].launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env[`${name.toUpperCase()}_PATH`]
})
try {
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', error => console.error('page error:', error))
  page.on('console', message => {
    if (message.type() === 'error') console.error('console:', message.text())
  })
  if (args.compact) {
    await page.goto(`http://127.0.0.1:${server.port}/compact`)
    await page.waitForFunction(() => 'runCompactBenchmark' in window)
    const results = await page.evaluate(
      options => (window as any).runCompactBenchmark(options),
      {
        rounds: Number(args.rounds),
        readCache: args['read-cache'] ? JSON.parse(args['read-cache']) : undefined
      }
    )
    console.log(JSON.stringify(results, null, 2))
  } else if (args.fts) {
    const runs = Number(args.runs)
    if (!Number.isInteger(runs) || runs < 1)
      throw new Error(`--runs must be a whole number of at least 1, not ${args.runs}`)
    await page.goto(`http://127.0.0.1:${server.port}/fts`)
    await page.waitForFunction(() => 'runFtsBenchmark' in window)
    const results = await page.evaluate(
      options => (window as any).runFtsBenchmark(options),
      {
        runs,
        readCache: args['read-cache'] ? JSON.parse(args['read-cache']) : undefined
      }
    )
    console.log(JSON.stringify(results, null, 2))
  } else if (args.bench) {
    await page.goto(`http://127.0.0.1:${server.port}/bench`)
    await page.waitForFunction(() => 'runBenchmarks' in window)
    const seconds = Number(args.seconds)
    const results = await page.evaluate(
      seconds => (window as any).runBenchmarks({seconds}),
      seconds
    )
    const report = {
      browser: name,
      date: new Date().toISOString(),
      machine: {
        os: `${type()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memory: totalmem()
      },
      ...results
    }
    console.log(JSON.stringify(report, null, 2))
    const file = args.out ?? `bench-results/${name}.json`
    await mkdir(dirname(file), {recursive: true})
    await writeFile(file, JSON.stringify(report, null, 2) + '\n')
  } else {
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => 'runTests' in window)
    const results: Array<{name: string; ok: boolean; ms?: number; error?: string}> =
      await page.evaluate(() => (window as any).runTests())
    for (const result of results) {
      if (result.ok) {
        console.log(`(pass) ${result.name} [${result.ms!.toFixed(0)}ms]`)
      } else {
        failed++
        console.log(`(fail) ${result.name}\n  ${result.error}`)
      }
    }
    console.log(`\n ${results.length - failed} pass\n ${failed} fail`)
  }
} finally {
  await context.close()
  server.stop()
  await rm(out, {recursive: true, force: true})
  await rm(profile, {recursive: true, force: true})
}
process.exit(failed ? 1 : 0)
