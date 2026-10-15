export type ScreenShareScope = { kind: 'group'; id: number } | { kind: 'private'; peerId: number };
export type MediaScopeId = number | `private:${number}:${number}`;

export function resolveScreenScope(scope: ScreenShareScope, userId: number): MediaScopeId {
  const id = scope?.kind === 'group' ? scope.id : scope?.kind === 'private' ? scope.peerId : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('共享会话无效');
  if (scope.kind === 'group') return id;
  if (id === userId) throw new Error('不能向自己发起共享');
  return `private:${Math.min(id, userId)}:${Math.max(id, userId)}`;
}

export function privateScreenMembers(scope: MediaScopeId): number[] {
  return typeof scope === 'string' ? scope.split(':').slice(1).map(Number) : [];
}

// The existing media-session engine handles both scopes. Legacy group event names
// stay internal so audio/video clients can continue using their current protocol.
export const screenShareActions = {
  start: 'group_call_start',
  end: 'group_call_end',
  join: 'join_group_call',
  leave: 'leave_group_call',
  offer: 'group_webrtc_offer',
  answer: 'group_webrtc_answer',
  ice: 'group_webrtc_ice',
  draft: 'screen_annotation_draft',
  complete: 'screen_annotation_complete',
  undo: 'screen_annotation_undo',
  clear: 'screen_annotation_clear',
  mic: 'toggle_mic',
  controlMic: 'control_member_mic',
} as const;
