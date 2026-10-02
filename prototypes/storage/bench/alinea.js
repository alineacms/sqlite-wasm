import {createRemoteAdapter} from './rpc.js';

export default createRemoteAdapter(
  'alinea',
  () => new Worker(new URL('./alinea-worker.js', import.meta.url), {type: 'module'}),
);
