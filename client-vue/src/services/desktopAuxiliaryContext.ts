import { isTauri } from '@tauri-apps/api/core';

export const isDesktopWindow = import.meta.env.VITE_DESKTOP === 'true' && isTauri();
export const auxiliaryId = isDesktopWindow
  ? new URLSearchParams(window.location.search).get('auxiliary')
  : null;
export const isAuxiliaryWindow = !!auxiliaryId;

let closeHandler: (() => void) | undefined;
export function setAuxiliaryCloseHandler(handler: () => void) {
  closeHandler = handler;
}
export function closeAuxiliaryWindow() {
  closeHandler?.();
}
