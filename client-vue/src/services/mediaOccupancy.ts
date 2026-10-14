import { readonly, shallowRef } from 'vue';
import { registerRemoteControlCleanup } from './remoteControlSafety';

export type MediaKind = 'private-call' | 'group-call' | 'group-screen' | 'remote-control';
export interface MediaClaim {
  readonly owner: string;
  readonly kind: MediaKind;
  release(): void;
  isCurrent(): boolean;
}

/** One local endpoint may capture/play session media for only one call at a time. */
export function createMediaOccupancy() {
  const current = shallowRef<{ owner: string; kind: MediaKind } | null>(null);
  let revoke: ((reason: string) => void) | null = null;
  let activeClaim: MediaClaim | null = null;
  return {
    current: readonly(current),
    acquire(
      kind: MediaKind,
      owner: string,
      onRevoke?: (reason: string) => void,
    ): MediaClaim | null {
      if (
        !owner ||
        (current.value && (current.value.owner !== owner || current.value.kind !== kind))
      )
        return null;
      if (activeClaim) {
        if (onRevoke) revoke = onRevoke;
        return activeClaim;
      }
      const claim: MediaClaim = {
        owner,
        kind,
        isCurrent: () => activeClaim === claim,
        release: () => {
          if (activeClaim === claim) {
            activeClaim = null;
            current.value = null;
            revoke = null;
          }
        },
      };
      activeClaim = claim;
      current.value = { owner, kind };
      revoke = onRevoke || null;
      return claim;
    },
    stop(reason: string) {
      const callback = revoke;
      activeClaim?.release();
      callback?.(reason);
    },
  };
}

export const mediaOccupancy = createMediaOccupancy();
registerRemoteControlCleanup((reason) => mediaOccupancy.stop(reason));
