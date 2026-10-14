const key = (userId: number) => `todesk:group-cursors:${userId}`;

export function readGroupCursors(userId: number): Record<number, number> {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function advanceGroupCursor(userId: number, groupId: number, messageId: number) {
  if (!Number.isSafeInteger(messageId) || messageId < 1) return;
  const cursors = readGroupCursors(userId);
  if (messageId <= (Number(cursors[groupId]) || 0)) return;
  cursors[groupId] = messageId;
  localStorage.setItem(key(userId), JSON.stringify(cursors));
}

export function initializeGroupCursor(userId: number, groupId: number, messageId: number) {
  const cursors = readGroupCursors(userId);
  if (cursors[groupId] !== undefined) return;
  cursors[groupId] = Math.max(0, Number(messageId) || 0);
  localStorage.setItem(key(userId), JSON.stringify(cursors));
}
