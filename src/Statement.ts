import type {
  BindParams,
  ParamsObject,
  SqlValue,
  Statement as StatementI
} from 'sql.js'
import type {Database} from './Database.js'
import {SQLite3Wasm} from './sqlite3-emscripten.cjs'
import {
  NumberedArray,
  ParameterArray,
  ParameterMap,
  Pointer,
  ReturnCode,
  ReturnMap,
  SQLParameterType,
  SQLReturnType
} from './sqlite3-types.js'

/* Represents a prepared statement.

Prepared statements allow you to have a template sql string,
that you can execute multiple times with different parameters.

You can't instantiate this class directly, you have to use a [Database](Database.html)
object in order to create a statement.

**Warning**: When you close a database (using db.close()), all its statements are
closed too and become unusable.

@see Database.html#prepare-dynamic
@see https://en.wikipedia.org/wiki/Prepared_statement
  */
export class Statement implements StatementI {
  private readonly wasm: SQLite3Wasm
  private stmt: Pointer
  private readonly db: Database
  private pos: number
  private readonly allocatedmem: Pointer[]

  public constructor(stmt: Pointer, db: Database) {
    this.wasm = db.wasm
    this.stmt = stmt
    this.db = db
    this.pos = 1
    this.allocatedmem = []
  }

  /**
   * Bind values to the parameters, after having reseted the statement. If
   * values is null, do nothing and return true.
   *
   * SQL statements can have parameters, named '?', '?NNN', ':VVV',
   * '@VVV', '$VVV', where NNN is a number and VVV a string. This function
   * binds these parameters to the given values.
   *
   * Warning: ':', '@', and '$' are included in the parameters names
   *
   * ### Value types
   *
   * |Javascript type|SQLite type|
   * |-|-|
   * |number|REAL, INTEGER|
   * |boolean|INTEGER|
   * |string|TEXT|
   * |Array, Uint8Array|BLOB|
   * |null|NULL|
   * @see [https://sql.js.org/documentation/Statement.html#["bind"]](https://sql.js.org/documentation/Statement.html#%5B%22bind%22%5D)
   *
   * @param values The values to bind
   */
  bind(values?: BindParams): boolean {
    // eslint-disable-next-line no-shadow
    const bindFromArray = (values: ParameterArray): void => {
      values.forEach((value, i) => {
        this.bindValue(value, i + 1)
      })
    }

    const bindFromObject = (valuesObj: ParameterMap): void => {
      for (const [name, value] of Object.entries(valuesObj)) {
        const num = this.wasm.sqlite3_bind_parameter_index(this.stmt, name)
        if (num !== 0) {
          this.bindValue(value, num)
        }
      }
    }

    // Code
    if (!this.stmt) {
      throw new Error('Statement closed')
    }
    this.reset()
    if (Array.isArray(values)) {
      bindFromArray(values)
    } else if (values) {
      bindFromObject(values)
    }
    return true
  }

  private bindValue(val: SQLParameterType, pos: number = this.pos++): void {
    // Nested functions
    /* eslint-disable no-shadow */
    const bindString = (str: string, pos: number = this.pos++): void => {
      const bytes = this.wasm.intArrayFromString(str)
      const strPtr = this.wasm.allocate(bytes, 'i8', this.wasm.ALLOC_NORMAL)
      this.allocatedmem.push(strPtr)
      this.db.handleError(
        this.wasm.sqlite3_bind_text(this.stmt, pos, strPtr, bytes.length - 1, 0)
      )
    }

    const bindBlob = (array: NumberedArray, pos: number = this.pos++): void => {
      const blobPtr = this.wasm.allocate(array, 'i8', this.wasm.ALLOC_NORMAL)
      this.allocatedmem.push(blobPtr)
      this.db.handleError(
        this.wasm.sqlite3_bind_blob(this.stmt, pos, blobPtr, array.length, 0)
      )
    }

    const bindNumber = (num: number, pos: number = this.pos++): void => {
      // eslint-disable-next-line no-bitwise
      const bindfunc =
        num === (num | 0)
          ? this.wasm.sqlite3_bind_int
          : this.wasm.sqlite3_bind_double
      this.db.handleError(bindfunc(this.stmt, pos, num))
    }

    const bindNull = (pos: number = this.pos++): void => {
      this.db.handleError(this.wasm.sqlite3_bind_blob(this.stmt, pos, 0, 0, 0))
    }
    /* eslint-enable no-shadow */

    // Code
    switch (typeof val) {
      case 'string':
        bindString(val, pos)
        break
      case 'number':
      case 'boolean':
        bindNumber((val as number) + 0, pos)
        break
      case 'object':
        if (val === null) {
          bindNull(pos)
        } else if (Array.isArray(val)) {
          bindBlob(val, pos)
        } else {
          throw new Error(
            `Wrong API use : tried to bind a value of an unknown type (${val}).`
          )
        }
        break
      default:
        throw new Error(
          `Wrong API use : tried to bind a value of an unknown type (${val}).`
        )
    }
    return
  }

  /**
   * Execute the statement, fetching the the next line of result, that can
   * be retrieved with `Statement.get`.
   * @see [https://sql.js.org/documentation/Statement.html#["step"]](https://sql.js.org/documentation/Statement.html#%5B%22step%22%5D)
   */
  public step(): boolean {
    if (!this.stmt) {
      throw new Error('Statement closed')
    }
    this.pos = 1
    const ret = this.wasm.sqlite3_step(this.stmt)
    switch (ret) {
      case ReturnCode.ROW:
        return true
      case ReturnCode.DONE:
        return false
      default:
        this.db.handleError(ret)
        return false
    }
  }

  /**
   * Get one row of results of a statement. If the first parameter is not
   * provided, step must have been called before.
   * @see [https://sql.js.org/documentation/Statement.html#["get"]](https://sql.js.org/documentation/Statement.html#%5B%22get%22%5D)
   *
   * @param params If set, the values will be bound to the statement
   * before it is executed
   */
  get(params?: BindParams): SqlValue[] {
    const getNumber = (pos: number = this.pos++): number => {
      return this.wasm.sqlite3_column_double(this.stmt, pos)
    }

    const getString = (pos: number = this.pos++): string => {
      // [TODO] What does it return, pointer or string?
      return this.wasm.sqlite3_column_text(this.stmt, pos)
    }

    const getBlob = (pos: number = this.pos++): Uint8Array => {
      const ptr: Pointer = this.wasm.sqlite3_column_blob(this.stmt, pos)
      const size: number = this.wasm.sqlite3_column_bytes(this.stmt, pos)
      return this.wasm.HEAPU8.subarray(ptr, ptr + size)
    }

    if (typeof params !== 'undefined') {
      this.bind(params)
      this.step()
    }
    const results: SQLReturnType[] = []
    const colSize = this.wasm.sqlite3_data_count(this.stmt)
    for (let col = 0; col < colSize; col++) {
      switch (this.wasm.sqlite3_column_type(this.stmt, col)) {
        case ReturnCode.INTEGER:
        case ReturnCode.FLOAT:
          results.push(getNumber(col))
          break
        case ReturnCode.TEXT:
          results.push(getString(col))
          break
        case ReturnCode.BLOB:
          results.push(getBlob(col))
          break
        default:
          results.push(null)
          break
      }
    }
    return results
  }

  /**
   * Get the list of column names of a row of result of a statement.
   * @see [https://sql.js.org/documentation/Statement.html#["getColumnNames"]](https://sql.js.org/documentation/Statement.html#%5B%22getColumnNames%22%5D)
   */
  getColumnNames(): string[] {
    const results: string[] = []
    const colSize = this.wasm.sqlite3_data_count(this.stmt)
    for (let col = 0; col < colSize; col++) {
      results.push(this.wasm.sqlite3_column_name(this.stmt, col))
    }
    return results
  }

  /**
   * Get one row of result as a javascript object, associating column
   * names with their value in the current row
   * @see [https://sql.js.org/documentation/Statement.html#["getAsObject"]](https://sql.js.org/documentation/Statement.html#%5B%22getAsObject%22%5D)
   *
   * @param params If set, the values will be bound to the statement, and
   * it will be executed
   */
  getAsObject(params?: BindParams): ParamsObject {
    const values = this.get(params)
    const names = this.getColumnNames()
    const rowObject: ReturnMap = {}
    names.forEach((name, i) => {
      rowObject[name] = values[i]
    })
    return rowObject
  }

  /**
   * Shorthand for bind + step + reset Bind the values, execute the
   * statement, ignoring the rows it returns, and resets it
   * @param values Value to bind to the statement
   */
  run(values?: BindParams): void {
    if (typeof values !== 'undefined') {
      this.bind(values)
    }
    this.step()
    this.reset()
  }

  /**
   * Reset a statement, so that it's parameters can be bound to new
   * values. It also clears all previous bindings, freeing the memory used
   * by bound parameters.
   * @see [https://sql.js.org/documentation/Statement.html#["reset"]](https://sql.js.org/documentation/Statement.html#%5B%22reset%22%5D)
   */
  reset(): boolean {
    this.freemem()
    return (
      this.wasm.sqlite3_clear_bindings(this.stmt) === ReturnCode.OK &&
      this.wasm.sqlite3_reset(this.stmt) === ReturnCode.OK
    )
  }

  /**
   * Free the memory allocated during parameter binding
   * @see [https://sql.js.org/documentation/Statement.html#["freemem"]](https://sql.js.org/documentation/Statement.html#%5B%22freemem%22%5D)
   */
  freemem() {
    let mem
    while ((mem = this.allocatedmem.pop())) {
      this.wasm._free(mem)
    }
    return null
  }

  /**
   * Free the memory used by the statement
   * @see [https://sql.js.org/documentation/Statement.html#["free"]](https://sql.js.org/documentation/Statement.html#%5B%22free%22%5D)
   */
  public free(): boolean {
    this.freemem()
    const res = this.wasm.sqlite3_finalize(this.stmt) === ReturnCode.OK
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.db.statements[this.stmt]
    this.stmt = this.wasm.NULL
    return res
  }

  /**
   * Get the SQLite's normalized version of the SQL string used in
   * preparing this statement. The meaning of "normalized" is not
   * well-defined: see
   * [the SQLite documentation](https://sqlite.org/c3ref/expanded_sql.html).
   * @see [https://sql.js.org/documentation/Statement.html#["getNormalizedSQL"]](https://sql.js.org/documentation/Statement.html#%5B%22getNormalizedSQL%22%5D)
   */
  getNormalizedSQL(): string {
    return this.wasm.sqlite3_normalized_sql(this.stmt)
  }

  /**
   * Get the SQL string used in preparing this statement.
   * @see [https://sql.js.org/documentation/Statement.html#["getSQL"]](https://sql.js.org/documentation/Statement.html#%5B%22getSQL%22%5D)
   */
  getSQL(): string {
    return this.wasm.sqlite3_sql(this.stmt)
  }
}
