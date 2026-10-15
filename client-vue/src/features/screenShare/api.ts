import type { Socket } from 'socket.io-client';

export type ScreenShareScope = { kind: 'group'; id: number } | { kind: 'private'; peerId: number };
export type ScreenShareId = number | `private:${number}:${number}`;
export type ScreenShareAction =
  | 'state'
  | 'start'
  | 'join'
  | 'leave'
  | 'end'
  | 'decline'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'draft'
  | 'complete'
  | 'undo'
  | 'clear'
  | 'mic'
  | 'controlMic';

export function screenShareId(scope: ScreenShareScope, userId: number): ScreenShareId {
  return scope.kind === 'group'
    ? scope.id
    : `private:${Math.min(scope.peerId, userId)}:${Math.max(scope.peerId, userId)}`;
}

export function createScreenShareApi(scope: ScreenShareScope, socket: () => Socket | null) {
  return {
    send(action: ScreenShareAction, payload: Record<string, unknown> = {}) {
      socket()?.emit('screen_share', { scope, action, payload });
    },
  };
}
