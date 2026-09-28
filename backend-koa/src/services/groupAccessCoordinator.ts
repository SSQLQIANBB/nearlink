/** Single-process serialization shared by group Socket actions and HTTP revocation.
 * This is not a distributed lock; meeting remains a single active instance. */
const queues = new Map<number, Promise<unknown>>();
type Revocation = { groupId: number; userId?: number; reason: 'left' | 'deleted' };
const listeners = new Set<(event: Revocation) => void | Promise<void>>();

export async function runGroupOperation<T>(groupId: number, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(groupId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(groupId, current);
  try { return await current; }
  finally { if (queues.get(groupId) === current) queues.delete(groupId); }
}
export function onGroupAccessRevoked(listener: (event: Revocation) => void | Promise<void>) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Call after a committed membership mutation, inside runGroupOperation. All
 * listeners start immediately so room removal cannot wait on another's Redis IO. */
export async function revokeGroupAccess(event: Revocation) {
  const results = await Promise.allSettled([...listeners].map(listener => Promise.resolve().then(() => listener(event))));
  if (results.some(result => result.status === 'rejected')) {
    // Revocation is committed; do not expose SQL/credentials or report a false rollback.
    console.error('group_realtime_cleanup_failed', { groupId: event.groupId });
  }
}
