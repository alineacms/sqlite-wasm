import type {Database} from './Database.js'
import {SQLiteError} from './SQLiteError.js'

// One database, used from every tab: each tab runs shareDatabase() in a
// Worker of its own, the Web Locks API elects one of them to open the
// database, and the others send it their statements over a BroadcastChannel.
// When the owner goes away (its tab closed), its lock is released and the
// next Worker in line opens the database and takes over.
//
// Messages on the channel:
//   {type: 'request', id, client, statements, script}  to the owner
//   {type: 'response', id, client, result | error}      to one client
//   {type: 'owner', owner}                               a new owner is ready

/** A row, by column name. */
export type Row = Record<string, unknown>

/** A statement and the values to bind to its parameters. */
export type Statement = [sql: string, params?: ReadonlyArray<unknown>]

export interface SharedDatabaseOptions {
  /** Web Locks implementation (default: `navigator.locks`) */
  locks?: Pick<LockManager, 'request'>
  /** BroadcastChannel constructor (default: the global one) */
  BroadcastChannel?: new (name: string) => Channel
}

/** The parts of BroadcastChannel this module uses. */
export interface Channel {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: MessageEvent) => void) | null
}

interface Request {
  type: 'request'
  id: number
  client: string
  statements: Array<Statement>
  /** A parameter-free script of one or more statements, run with exec */
  script?: string
}

interface Response {
  type: 'response'
  id: number
  client: string
  result?: Array<Array<Row>>
  error?: {message: string; resultCode: number}
}

interface Pending {
  request: Request
  resolve(result: Array<Array<Row>>): void
  reject(error: unknown): void
}

const SQLITE_ERROR = 1
const SQLITE_MISUSE = 21
// How long an answered request is remembered, to ignore it if it arrives
// again: requests are sent again right after a new owner announces itself.
const REMEMBER_MS = 60_000

function toError(error: Response['error']) {
  return new SQLiteError(error!.message, error!.resultCode)
}

function fromError(error: unknown): Response['error'] {
  const resultCode = (error as SQLiteError)?.resultCode
  return {
    message: String((error as Error)?.message ?? error),
    resultCode: typeof resultCode === 'number' ? resultCode : SQLITE_ERROR
  }
}

/**
 * A database shared by every tab of an origin, opened by one of them. Its
 * methods resolve once the statements ran on the owner and their commits
 * are stored (`db.flush()`).
 */
export class SharedDatabase {
  private readonly id = crypto.randomUUID()
  private readonly channel: Channel
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private db?: Database
  private statements = new Map<string, ReturnType<Database['prepare']>>()
  // Requests received, by client and id, and when they were answered: a
  // client may send one again after this owner announced itself
  private handled = new Map<string, number | undefined>()
  private queue: Promise<unknown> = Promise.resolve()
  private release?: () => void
  private closed = false
  private abort = new AbortController()

  /** @internal */
  constructor(
    readonly name: string,
    private open: () => Promise<Database>,
    options: SharedDatabaseOptions = {}
  ) {
    const Channel = options.BroadcastChannel ?? globalThis.BroadcastChannel
    const locks = options.locks ?? globalThis.navigator?.locks
    if (!Channel || !locks) {
      throw new Error('Sharing a database needs BroadcastChannel and Web Locks')
    }
    this.channel = new Channel(`@alinea/sqlite-wasm:${name}`)
    this.channel.onmessage = event => this.receive(event.data)
    locks
      .request(
        `@alinea/sqlite-wasm:${name}`,
        {signal: this.abort.signal},
        () => this.own()
      )
      .catch(() => {
        // Aborted by close() while waiting for the lock.
      })
  }

  /** True while this Worker has the database open for every tab. */
  get isOwner() {
    return this.db !== undefined
  }

  /** Run one statement and return its rows. */
  async query(sql: string, params?: ReadonlyArray<unknown>): Promise<Array<Row>> {
    const [rows] = await this.send({statements: [[sql, params]]})
    return rows
  }

  /** Run a script of one or more statements without parameters. */
  async exec(sql: string): Promise<void> {
    await this.send({statements: [], script: sql})
  }

  /**
   * Run statements in one transaction, and return the rows of each. If one
   * fails, the transaction is rolled back and the promise rejects.
   */
  transaction(statements: Array<Statement>): Promise<Array<Array<Row>>> {
    return this.send({statements, transaction: true})
  }

  /**
   * Stop using the shared database. If this Worker owns it, the database is
   * closed and the next Worker in line opens it.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    const error = new SQLiteError('Shared database closed', SQLITE_MISUSE)
    for (const {reject} of this.pending.values()) reject(error)
    this.pending.clear()
    await this.queue
    if (this.db) {
      const db = this.db
      this.db = undefined
      for (const statement of this.statements.values()) statement.free()
      this.statements.clear()
      try {
        await db.flush()
      } finally {
        db.close()
      }
    }
    this.channel.close()
    this.release?.()
  }

  private send(options: {
    statements: Array<Statement>
    script?: string
    transaction?: boolean
  }): Promise<Array<Array<Row>>> {
    if (this.closed) {
      return Promise.reject(
        new SQLiteError('Shared database closed', SQLITE_MISUSE)
      )
    }
    let statements = options.statements
    if (options.transaction) {
      statements = [['BEGIN'], ...statements, ['COMMIT']]
    }
    const request: Request = {
      type: 'request',
      id: this.nextId++,
      client: this.id,
      statements,
      script: options.script
    }
    return new Promise((resolve, reject) => {
      const result = options.transaction
        ? (rows: Array<Array<Row>>) => resolve(rows.slice(1, -1))
        : resolve
      this.pending.set(request.id, {request, resolve: result, reject})
      if (this.db) this.handle(request)
      else this.channel.postMessage(request)
    })
  }

  private receive(message: Request | Response | {type: 'owner'}) {
    if (this.closed) return
    switch (message.type) {
      case 'request':
        if (this.db) this.handle(message)
        return
      case 'response': {
        if (message.client !== this.id) return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(toError(message.error))
        else pending.resolve(message.result!)
        return
      }
      case 'owner':
        // The previous owner may have gone away without answering: send
        // what is unanswered again. A request that it did run, but did not
        // answer, runs twice.
        for (const {request} of this.pending.values()) {
          this.channel.postMessage(request)
        }
        return
    }
  }

  // Holds the lock until close(), or until the Worker ends.
  private async own() {
    if (this.closed) return
    try {
      this.db = await this.open()
    } catch (error) {
      // Not opened: reject what waits, and leave it to the next in line.
      const failure = fromError(error)
      for (const {reject} of this.pending.values()) reject(toError(failure))
      this.pending.clear()
      return
    }
    if (this.closed) {
      this.db.close()
      this.db = undefined
      return
    }
    // This Worker's own requests, which no owner answered yet
    for (const {request} of this.pending.values()) this.handle(request)
    this.channel.postMessage({type: 'owner', owner: this.id})
    await new Promise<void>(resolve => (this.release = resolve))
  }

  // Run a request on the owned database, one at a time, and answer it.
  private handle(request: Request) {
    const key = `${request.client}:${request.id}`
    if (this.handled.has(key)) return
    const now = Date.now()
    for (const [handled, answered] of this.handled) {
      if (answered === undefined || now - answered < REMEMBER_MS) break
      this.handled.delete(handled)
    }
    this.handled.set(key, undefined)
    this.queue = this.queue.then(async () => {
      const response: Response = {
        type: 'response',
        id: request.id,
        client: request.client
      }
      try {
        response.result = this.run(request)
        await this.db!.flush()
      } catch (error) {
        response.error = fromError(error)
      }
      if (request.client === this.id) this.receive(response)
      else this.channel.postMessage(response)
      this.handled.set(key, Date.now())
    })
  }

  // Statements run synchronously, so nothing else runs in between.
  private run(request: Request): Array<Array<Row>> {
    const db = this.db!
    const results: Array<Array<Row>> = []
    try {
      if (request.script !== undefined) db.run(request.script)
      for (const [sql, params] of request.statements) {
        results.push(this.rows(sql, params))
      }
    } catch (error) {
      if (db.inTransaction()) db.run('ROLLBACK')
      throw error
    }
    // A transaction left open would take in other tabs' statements.
    if (db.inTransaction()) {
      db.run('ROLLBACK')
      throw new SQLiteError(
        'A transaction must begin and end in one request: use transaction()',
        SQLITE_MISUSE
      )
    }
    return results
  }

  private rows(sql: string, params?: ReadonlyArray<unknown>): Array<Row> {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db!.prepare(sql)
      this.statements.set(sql, statement)
    }
    try {
      if (params?.length) statement.bind(params as any)
      const rows: Array<Row> = []
      while (statement.step()) rows.push(statement.getAsObject())
      return rows
    } finally {
      statement.reset()
    }
  }
}

/**
 * Use the database `name` from every tab of this origin. Call it in a
 * dedicated Worker in each tab; `open` opens the database, and is only
 * called in the Worker that owns it:
 *
 * ```ts
 * import {init} from '@alinea/sqlite-wasm'
 * import {opfsStorage} from '@alinea/sqlite-wasm/opfs'
 * import {shareDatabase} from '@alinea/sqlite-wasm/shared'
 *
 * const db = shareDatabase('notes', async () => {
 *   const {Database} = await init()
 *   return Database.sync(opfsStorage('notes.sqlite3'))
 * })
 * await db.exec('create table if not exists notes (text)')
 * await db.transaction([['insert into notes values (?)', ['shared']]])
 * console.log(await db.query('select * from notes'))
 * ```
 *
 * The Web Locks API elects one Worker to open the database; the others send
 * it their statements over a BroadcastChannel. Requests run one at a time,
 * and a transaction runs all its statements in one go, so tabs never
 * interleave inside one. When the owner's tab closes, the next Worker in
 * line opens the database and the others send what was not answered yet
 * again: a request the previous owner ran without answering runs twice, so
 * make writes safe to repeat where that matters.
 */
export function shareDatabase(
  name: string,
  open: () => Promise<Database>,
  options?: SharedDatabaseOptions
): SharedDatabase {
  return new SharedDatabase(name, open, options)
}
