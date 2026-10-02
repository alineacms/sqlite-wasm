import {createRemoteAdapter} from '../rpc.js'

export default createRemoteAdapter(
  'proto-retry',
  () => new Worker(new URL('./retry-worker.js', import.meta.url), {type: 'module'}),
)
