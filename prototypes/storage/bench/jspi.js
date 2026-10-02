import {createRemoteAdapter} from '../rpc.js'

export default createRemoteAdapter(
  'proto-jspi',
  () => new Worker(new URL('./jspi-worker.js', import.meta.url), {type: 'module'}),
)
