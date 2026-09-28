/** Display preferences only. This storage must never contain credentials or authorization. */
export const remoteScales = ['fit', '50', '100', '150', '200'] as const;
export type RemoteScale = typeof remoteScales[number];
export interface RemoteViewPreferences { scale: RemoteScale; showStats: boolean }
export const defaultRemoteViewPreferences = (): RemoteViewPreferences => ({ scale: 'fit', showStats: true });
function key(userId: number, deviceId: string) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(deviceId)) return null;
  return `remote-view:v1:${userId}:${deviceId.toLowerCase()}`;
}
function parse(value: unknown): RemoteViewPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !remoteScales.includes(item.scale as RemoteScale) || typeof item.showStats !== 'boolean') return null;
  return { scale: item.scale as RemoteScale, showStats: item.showStats };
}
export function readRemoteViewPreferences(userId: number, deviceId: string): RemoteViewPreferences {
  const storageKey = key(userId, deviceId);
  if (storageKey) {
    try { return parse(JSON.parse(localStorage.getItem(storageKey) || 'null')) || defaultRemoteViewPreferences(); }
    catch { /* Storage can be disabled or contain invalid data. */ }
  }
  return defaultRemoteViewPreferences();
}
export function saveRemoteViewPreferences(userId: number, deviceId: string, value: RemoteViewPreferences) {
  const storageKey = key(userId, deviceId);
  const safe = parse({ version: 1, scale: value.scale, showStats: value.showStats });
  if (!storageKey || !safe) return false;
  try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...safe })); return true; }
  catch { return false; }
}
