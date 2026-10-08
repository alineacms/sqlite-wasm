// Prints the results script/test-browser.ts --bench wrote to bench-results/
// as the Markdown tables of BENCHMARKS.md.
//
//   bun script/benchmark-report.ts [bench-results/chromium.json ...]
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await readdir('bench-results'))
      .filter(file => file.endsWith('.json'))
      .map(file => join('bench-results', file))
const order = ['chromium', 'firefox', 'webkit']
const reports = (
  await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))))
).sort((a, b) => order.indexOf(a.browser) - order.indexOf(b.browser))

const VARIANTS: Record<string, string> = {opfs: 'OPFS files', indexeddb: 'IndexedDB Blobs'}
// Pages a checkpoint copies out of Wasm memory at once: OPFS writes runs
// of up to 4 MB; IndexedDB passes every page to one Blob (see snapshots.ts).
const OPFS_RUN = 4 << 20

function version(report: any) {
  const ua: string = report.userAgent
  const match =
    ua.match(/HeadlessChrome\/([\d.]+)/) ??
    ua.match(/Firefox\/([\d.]+)/) ??
    ua.match(/Version\/([\d.]+)/)
  return `${report.browser} ${match?.[1] ?? '?'}`
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
const ms = (value: number) =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
const failed = (value: any) => value === undefined || value?.error

function table(head: Array<string>, rows: Array<Array<string | number>>) {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`)
  ].join('\n')
}

function each(
  pick: (variant: any, report: any, name: string) => Array<Array<string | number>>
) {
  const rows: Array<Array<string | number>> = []
  for (const report of reports) {
    for (const [name, label] of Object.entries(VARIANTS)) {
      const variant = report.variants[name]
      for (const row of pick(variant, report, name))
        rows.push([version(report), label, ...row])
    }
  }
  return rows
}

const error = (value: any, columns: number) => [
  `failed: ${value?.error ?? 'not run'}`,
  ...Array(columns - 1).fill('')
]

const out: Array<string> = []
const first = reports[0]
out.push(
  `Machine: ${first.machine.cpu}, ${first.machine.cores} cores, ` +
    `${(first.machine.memory / 2 ** 30).toFixed(0)} GiB, ${first.machine.os}. ` +
    `Browsers: ${reports.map(version).join(', ')} (Playwright ` +
    `builds, headless). Run on ${first.date.slice(0, 10)}.`
)

out.push('### 1. Writing the first base\n')
out.push(
  table(
    ['Browser', 'Bases', 'Size (MB)', 'Time (ms)', 'Wasm heap (MB)', 'Wasm growth (MB)'],
    each(v =>
      failed(v.firstBase)
        ? [error(v.firstBase, 4)]
        : [[mb(v.firstBase.size), ms(v.firstBase.ms), mb(v.firstBase.wasmHeap), mb(v.firstBase.wasmGrowth)]]
    )
  )
)

out.push('\n### 2. Opening an overlay\n')
out.push(
  table(
    ['Browser', 'Bases', 'Open (ms)', 'To first query (ms)'],
    each(v =>
      failed(v.open) ? [error(v.open, 2)] : [[ms(v.open.openMs), ms(v.open.ms)]]
    )
  )
)

for (const [key, title] of [
  ['queries', '### 3. Queries (default page cache, 8 MB)'],
  ['queriesLargeCache', '### 3b. Queries with a 64 MB page cache, which holds the database']
]) {
  out.push(`\n${title}\n`)
  out.push(
    table(
      ['Browser', 'Bases', 'Point cold', 'Point warm', 'Range cold', 'Range warm', 'Full cold', 'Full warm'],
      each(v => {
        const q = v[key]
        if (failed(q)) return [error(q, 6)]
        return [[q.point, q.range, q.full].flatMap(r => [ms(r.cold), ms(r.warm)])]
      })
    )
  )
}

out.push('\n### 4. Checkpoints after changing rows\n')
out.push(
  table(
    ['Browser', 'Bases', 'Rows', 'Pages held (MB)', 'Time (ms)', 'Wasm heap (MB)', 'Wasm growth (MB)', 'Copied out of Wasm at once (MB)'],
    each((v, _, name) =>
      ['10', '1000', '20000'].map(count => {
        const c = v.checkpoints?.[count]
        if (failed(c)) return [count, ...error(c, 5)]
        const copied = name === 'opfs' ? Math.min(c.held, OPFS_RUN) : c.held
        return [count, mb(c.held), ms(c.ms), mb(c.wasmHeap), mb(c.wasmGrowth), mb(copied)]
      })
    )
  )
)

out.push('\n### 5. Two SharedWorkers on one base\n')
out.push(
  table(
    ['Browser', 'Bases', 'Seconds', 'Checkpoints', 'Reader rounds', 'Bases left (expected)', 'Correct'],
    each(v => {
      const t = v.twoWorkers
      if (failed(t)) return [error(t, 5)]
      return [[t.seconds, t.checkpoints, t.readerRounds, `${t.bases} (${t.expectedBases})`, t.ok ? 'yes' : 'NO']]
    })
  )
)

out.push('\n### 6. Reading a base after its stored entry was deleted\n')
out.push(
  table(
    ['Browser', 'Bases', 'Result'],
    each(v => {
      const d = v.deletedRead
      if (!d) return [['not run']]
      if (d.error) return [[`fails: ${d.error}`]]
      return [[d.ok ? 'reads every page' : `wrong: ${d.count} rows`]]
    })
  )
)

out.push('\n### 7. Support\n')
const kinds = ['shared opfs', 'shared indexeddb', 'dedicated opfs', 'dedicated indexeddb']
out.push(
  table(
    ['Browser', 'SharedWorker, OPFS', 'SharedWorker, IndexedDB', 'Worker, OPFS', 'Worker, IndexedDB'],
    reports.map(report => [
      version(report),
      ...kinds.map(kind => {
        const s = report.support?.[kind]
        return s?.ok ? 'works' : `fails: ${s?.error ?? 'not run'}`
      })
    ])
  )
)

console.log(out.join('\n'))
