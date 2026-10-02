import {createRemoteAdapter} from '../rpc.js'

export default createRemoteAdapter(
  'proto-opfs',
  () => new Worker(new URL('./opfs-worker.js', import.meta.url), {type: 'module'}),
)
