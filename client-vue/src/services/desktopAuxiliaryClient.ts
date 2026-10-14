import { io, type Socket } from 'socket.io-client';
import { shallowRef } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { auxiliaryId, setAuxiliaryCloseHandler } from './desktopAuxiliaryContext';
import type { AuxiliaryBootstrap, AuxiliaryContent } from './desktopAuxiliaryWindows';
import { DesktopWindowChannel, prepareDesktopWindowChannel } from './desktopWindowChannel';
import { useAuthStore } from '@/stores/auth';
import { pinia } from '@/stores';

export const auxiliaryContent = shallowRef<AuxiliaryContent>();
export let auxiliarySocket: Socket;
export let auxiliaryAuthenticated = false;
let channel: DesktopWindowChannel;
let bootstrap: AuxiliaryBootstrap;
let closeWindow: () => void;
let mounted = false;
let closing = false;
let pendingSignals: { event: string; args: unknown[] }[] = [];
let finishRefresh: ((success: boolean) => void) | undefined;
let pendingRefresh: Promise<boolean> | undefined;
export function refreshAuxiliaryAuth(): Promise<boolean> {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      finishRefresh = undefined;
      resolve(false);
    }, 12000);
    finishRefresh = (success) => {
      clearTimeout(timer);
      finishRefresh = undefined;
      resolve(success);
    };
    channel.postMessage({ type: 'refresh-auth', token: useAuthStore(pinia).token });
  }).finally(() => {
    pendingRefresh = undefined;
  });
  return pendingRefresh;
}
export function reportAuxiliaryAuthFailure() {
  channel.postMessage({ type: 'auth-failed' });
  closeWindow?.();
}
function dispatchSignal(event: string, args: unknown[]) {
  for (const listener of [...auxiliarySocket.listeners(event)])
    listener.apply(auxiliarySocket, args);
}

export async function initializeAuxiliaryClient() {
  setAuxiliaryCloseHandler(() => {
    closing = true;
    closeWindow?.();
  });
  await prepareDesktopWindowChannel();
  channel = new DesktopWindowChannel(auxiliaryId!, 'main');
  bootstrap = await new Promise<AuxiliaryBootstrap>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('无法连接主窗口，请关闭后重试')), 15000);
    channel.onmessage = ({ data }) => {
      if (data.type === 'bootstrap') {
        clearTimeout(timer);
        resolve(data.bootstrap);
      }
    };
    channel.postMessage({ type: 'hello' });
  });
  auxiliaryContent.value = bootstrap.content;
  // 只借用 Socket 的事件 API，不建立第二条网络连接，保留主窗口的 socketId。
  auxiliarySocket = io({ autoConnect: false, forceNew: true });
  auxiliarySocket.id = bootstrap.socketId;
  auxiliarySocket.connected = bootstrap.connected;
  auxiliaryAuthenticated = bootstrap.authenticated;
  auxiliarySocket.emit = ((event: string, ...args: unknown[]) => {
    channel.postMessage({ type: 'emit', event, args: JSON.parse(JSON.stringify(args)) });
    return auxiliarySocket;
  }) as Socket['emit'];
  channel.onmessage = ({ data }) => {
    if (data.type === 'signal') {
      if (mounted) dispatchSignal(data.event, data.args);
      else pendingSignals.push(data);
    } else if (data.type === 'close') {
      closing = true;
      closeWindow?.();
    } else if (data.type === 'image') {
      auxiliaryContent.value = data.content;
    } else if (data.type === 'auth' || data.type === 'refreshed-auth') {
      bootstrap.token = data.token;
      bootstrap.refreshToken = data.refreshToken;
      useAuthStore(pinia).$patch({ token: data.token, refreshToken: data.refreshToken });
      if (data.type === 'refreshed-auth') finishRefresh?.(data.success);
    }
  };
  return bootstrap;
}

export async function mountAuxiliaryClient(unmount: () => void, startPrivateCall: () => void) {
  let disposed = false;
  const nativeWindow = getCurrentWindow();
  let unlisten: (() => void) | undefined;
  closeWindow = () => {
    if (disposed) return;
    disposed = true;
    finishRefresh?.(false);
    unlisten?.();
    // Vue 卸载先发送挂断/离开信令并释放轨道，主窗口收到 closed 后才销毁原生窗口。
    unmount();
    channel.postMessage({ type: 'closed' });
    channel.close();
  };
  setAuxiliaryCloseHandler(closeWindow);
  const removeListener = await nativeWindow.onCloseRequested((event) => {
    event.preventDefault();
    closeWindow();
  });
  if (disposed) {
    removeListener();
    return;
  }
  unlisten = removeListener;
  if (closing) {
    closeWindow();
    return;
  }
  mounted = true;
  if (bootstrap.content.kind === 'private') {
    if (bootstrap.content.incoming)
      dispatchSignal('webrtc_call_request', [bootstrap.content.incoming]);
    else startPrivateCall();
  }
  for (const signal of pendingSignals) dispatchSignal(signal.event, signal.args);
  pendingSignals = [];
  channel.postMessage({ type: 'ready' });
}
