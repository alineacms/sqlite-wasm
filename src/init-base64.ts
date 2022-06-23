import {Imports, loadModule} from './load-module.js'
import {decode} from 'base64-arraybuffer'

const source = '$SRC'

function getModule(imports: Imports) {
  return WebAssembly.instantiate(decode(source), imports).then(
    ({instance}) => instance
  )
}

export function init() {
  return loadModule(getModule)
}

export default init
