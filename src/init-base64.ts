import {Imports, loadModule} from './load-module.js'
import {decode} from 'buffer-to-base64/decode'

const source = '$SRC'

async function getModule(imports: Imports) {
  const buffer = await decode(source)
  const {instance} = await WebAssembly.instantiate(buffer, imports)
  return instance
}

export function init() {
  return loadModule(getModule)
}

export default init
