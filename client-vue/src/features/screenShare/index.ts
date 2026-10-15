import { defineAsyncComponent } from 'vue';
import type { Router } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { groupSessionState } from '@/services/groupSessionState';
import { isDesktopWindow, isAuxiliaryWindow } from '@/services/desktopAuxiliaryContext';
import { openAuxiliaryWindow } from '@/services/desktopAuxiliaryWindows';
import { captureGroupScreen, discardCapturedGroupScreen } from '@/services/screenShareLaunch';
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { screenShareId, type ScreenShareScope } from './api';
export { createScreenShareApi, screenShareId } from './api';
export type { ScreenShareScope, ScreenShareId, ScreenShareAction } from './api';

/** The only launch entry for personal and group screen sharing. */
export async function openScreenShare(scope: ScreenShareScope, router: Router, start = true) {
  if (mediaOccupancy.current.value) throw new Error('请先结束当前通话或远程控制');
  const id = screenShareId(scope, useAuthStore().currentUser!.id);
  const path =
    scope.kind === 'group' ? `/group-screen/${scope.id}` : `/screen-share/private/${scope.peerId}`;
  if (isDesktopWindow && !isAuxiliaryWindow) {
    await openAuxiliaryWindow({ kind: 'screen', path, scope });
    return;
  }
  const existing = scope.kind === 'group' && groupSessionState.getSession(scope.id, 'screen');
  try {
    if (start && !existing) await captureGroupScreen(id);
    const failure = await router.push(path);
    if (failure) discardCapturedGroupScreen(id);
  } catch (error) {
    discardCapturedGroupScreen(id);
    throw error;
  }
}

export const ScreenShare = defineAsyncComponent(() => import('./ScreenShare.vue'));
