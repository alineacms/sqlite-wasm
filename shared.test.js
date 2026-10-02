import {afterEach, beforeAll, beforeEach, describe, expect, test} from 'bun:test'
import {init} from '@alinea/sqlite-wasm'
import {fileStorage} from '@alinea/sqlite-wasm/opfs'
import {shareDatabase} from '@alinea/sqlite-wasm/shared'
import {MemoryFileSystem} from './memory-file-system.js'

// Each "tab" is a shareDatabase() in this process, with its own channel and
// a fake Web Locks implementation (Bun has none) that grants a lock to one
// tab at a time, in order. crash() ends a tab the way a closed tab does:
// it stops receiving and sending, its files close and its lock is released,
// without anything being answered or flushed.

class Locks {
  queue = []
  holder = null

  request(name, options, callback) {
    return new Promise((resolve, reject) => {
      const entry = {callback, resolve, reject}
      options.signal?.addEventListener('abort', () => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1)
        reject(new DOMException('Aborted', 'AbortError'))
      })
      this.queue.push(entry)
      this.grant()
    })
  }

  grant() {
    if (this.holder || !this.queue.length) return
    const entry = (this.holder = this.queue.shift())
    const done = () => {
      if (this.holder !== entry) return
      this.holder = null
      this.grant()
    }
    entry.release = done
    Promise.resolve(entry.callback()).then(
      value => (done(), entry.resolve(value)),
      error => (done(), entry.reject(error))
    )
  }
}

let Database
let fs
let locks
let tabs = []

beforeAll(async () => {
  ;({Database} = await init())
})

beforeEach(() => {
  fs = new MemoryFileSystem()
  locks = new Locks()
})

afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.db.close().catch(() => {})
})

function tab({open} = {}) {
  let crashed = false
  class Channel extends BroadcastChannel {
    postMessage(message) {
      if (!crashed) super.postMessage(message)
    }
    set onmessage(handler) {
      super.onmessage = event => {
        if (!crashed) handler(event)
      }
    }
  }
  const opened = []
  const db = shareDatabase(
    'notes',
    open ??
      (async () => {
        const database = await Database.sync(fileStorage('notes.sqlite3', fs))
        opened.push(database)
        return database
      }),
    {locks, BroadcastChannel: Channel}
  )
  const result = {
    db,
    crash() {
      crashed = true
      for (const database of opened) database.close()
      const entry = locks.holder
      if (entry && db.isOwner) entry.release()
    }
  }
  tabs.push(result)
  return result
}

const until = async condition => {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

describe('A shared database', () => {
  test('is opened by one tab and used by all', async () => {
    const a = tab()
    const b = tab()
    await b.db.exec('create table notes (id integer primary key, text)')
    await a.db.transaction([
      ['insert into notes (text) values (?)', ['from a']],
      ['insert into notes (text) values (?)', ['again']]
    ])
    expect(await b.db.query('select text from notes order by id')).toEqual([
      {text: 'from a'},
      {text: 'again'}
    ])
    expect([a.db.isOwner, b.db.isOwner]).toEqual([true, false])
  })

  test('returns the rows of every statement of a transaction', async () => {
    const a = tab()
    const b = tab()
    await a.db.exec('create table t (x)')
    const result = await b.db.transaction([
      ['insert into t values (?), (?)', [1, 2]],
      ['select sum(x) as total from t'],
      ['select x from t where x > ?', [1]]
    ])
    expect(result).toEqual([[], [{total: 3}], [{x: 2}]])
  })

  test('runs transactions from different tabs one after another', async () => {
    const tabsUsed = [tab(), tab(), tab()]
    await tabsUsed[0].db.exec('create table counter (n); insert into counter values (0)')
    const increments = []
    for (let i = 0; i < 30; i++) {
      increments.push(
        tabsUsed[i % 3].db.transaction([
          ['select n from counter'],
          ['update counter set n = n + 1']
        ])
      )
    }
    const seen = (await Promise.all(increments)).map(([[{n}]]) => n)
    expect(seen.sort((x, y) => x - y)).toEqual([...Array(30).keys()])
    expect(await tabsUsed[1].db.query('select n from counter')).toEqual([{n: 30}])
  })

  test('rolls back a failed transaction and reports the error', async () => {
    const a = tab()
    const b = tab()
    await a.db.exec('create table t (x unique)')
    await expect(
      b.db.transaction([
        ['insert into t values (1)'],
        ['insert into t values (1)']
      ])
    ).rejects.toMatchObject({code: 'SQLITE_CONSTRAINT'})
    expect(await b.db.query('select count(*) as n from t')).toEqual([{n: 0}])
  })

  test('does not let a transaction stay open between requests', async () => {
    const a = tab()
    const b = tab()
    await a.db.exec('create table t (x)')
    await expect(b.db.exec('begin; insert into t values (1)'))
      .rejects.toMatchObject({code: 'SQLITE_MISUSE'})
    await expect(b.db.query('begin')).rejects.toMatchObject({code: 'SQLITE_MISUSE'})
    await a.db.query('insert into t values (2)')
    expect(await b.db.query('select x from t')).toEqual([{x: 2}])
  })
})

describe('Handing over a shared database', () => {
  test('to the next tab when the owner closes', async () => {
    const a = tab()
    const b = tab()
    await a.db.exec('create table t (x)')
    await b.db.query('insert into t values (1)')
    await a.db.close()
    expect(await b.db.query('select x from t')).toEqual([{x: 1}])
    expect(b.db.isOwner).toBe(true)
  })

  test('to the next tab when the owner crashes, answering what it did not', async () => {
    const a = tab()
    const b = tab()
    const c = tab()
    await b.db.exec('create table t (x)')
    expect(a.db.isOwner).toBe(true)
    a.crash()
    // Sent while no tab owns the database: answered by the next owner.
    const pending = c.db.query('insert into t values (1)')
    await pending
    expect(b.db.isOwner).toBe(true)
    expect(await c.db.query('select x from t')).toEqual([{x: 1}])
  })

  test('keeps what was committed before the owner crashed', async () => {
    const a = tab()
    await a.db.exec('create table t (x); insert into t values (1)')
    a.crash()
    const b = tab()
    expect(await b.db.query('select x from t')).toEqual([{x: 1}])
  })

  test('rejects what waits when this tab closes', async () => {
    const owner = tab({open: () => new Promise(() => {})})
    const b = tab()
    const pending = b.db.query('select 1')
    await b.db.close()
    await expect(pending).rejects.toMatchObject({code: 'SQLITE_MISUSE'})
    await expect(b.db.query('select 1')).rejects.toMatchObject({code: 'SQLITE_MISUSE'})
    expect(owner.db.isOwner).toBe(false)
  })

  test('to the next tab when opening fails', async () => {
    const a = tab({
      open: async () => {
        throw new Error('cannot open')
      }
    })
    const pending = a.db.query('select 1 as one')
    await expect(pending).rejects.toThrow('cannot open')
    const b = tab()
    expect(await b.db.query('select 1 as one')).toEqual([{one: 1}])
    // a now sends its statements to b
    expect(await a.db.query('select 2 as two')).toEqual([{two: 2}])
  })
})
