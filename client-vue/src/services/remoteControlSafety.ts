import { invoke, isTauri } from '@tauri-apps/api/core';

const cleanupHandlers = new Set<(reason: string) => void>();

/** Register only local synchronous cleanup: input, media tracks and transports. */
export function registerRemoteControlCleanup(cleanup: (reason: string) => void) {
  cleanupHandlers.add(cleanup);
  return () => cleanupHandlers.delete(cleanup);
}

export function clearRemoteControlLocally(reason: string) {
  for (const cleanup of cleanupHandlers) {
    try {
      cleanup(reason);
    } catch (error) {
      console.error('Remote control local cleanup failed', error);
    }
  }
}

/** Local input closes before awaiting any network or native command. */
export async function stopRemoteControlLocally(reason: string) {
  clearRemoteControlLocally(reason);
  if (isTauri()) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        invoke('remote_control_stop'),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('REMOTE_LOCAL_STOP_TIMEOUT')), 1500);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
