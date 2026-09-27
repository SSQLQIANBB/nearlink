import type { Server } from 'http';
import { getRemoteControlContext } from './remoteControlContext';
import { RemoteControlRuntime } from './remoteControlRuntime';

/** This runs cleanup/audit while admission and native media release remain disabled. */
export function initializeRemoteControlRuntime(server: Server) {
  const { store, history, service } = getRemoteControlContext();
  const runtime = new RemoteControlRuntime(service, store, history);
  runtime.start();
  server.once('close', () => { void runtime.stop(); });
  return runtime;
}
