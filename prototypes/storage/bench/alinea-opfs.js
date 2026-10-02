import {createRemoteAdapter} from './rpc.js';

export default createRemoteAdapter(
  'alinea-opfs',
  () => new Worker(new URL('./alinea-opfs-worker.js', import.meta.url), {type: 'module'}),
);
