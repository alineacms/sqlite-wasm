// Runs test/browser in headless Chromium: file storage in OPFS and
// databases shared between Workers need a browser's OPFS, Web Locks and
// BroadcastChannel. Build first (bun run build). The Chromium build
// matching playwright-core must be installed
// (bunx playwright-core install chromium), or CHROMIUM_PATH set to another.
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'

const out = await mkdtemp(join(tmpdir(), 'sqlite-wasm-browser-'))
const profile = await mkdtemp(join(tmpdir(), 'sqlite-wasm-profile-'))
const built = await Bun.build({
  entrypoints: ['test/browser/page.js', 'test/browser/worker.js'],
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
    if (pathname === '/') {
      return new Response('<!doctype html><script type="module" src="./page.js"></script>', {
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
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH
})
try {
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', error => console.error('page error:', error))
  page.on('console', message => {
    if (message.type() === 'error') console.error('console:', message.text())
  })
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
} finally {
  await context.close()
  server.stop()
  await rm(out, {recursive: true, force: true})
  await rm(profile, {recursive: true, force: true})
}
process.exit(failed ? 1 : 0)
