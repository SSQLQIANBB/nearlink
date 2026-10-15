import { createScreenShareApi, type ScreenShareScope } from '@/features/screenShare/api';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { watch } from 'vue';
import type { Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import { useSocketStore } from '@/stores/socket';
import { usePrivateCallStore, type CallUser } from '@/stores/privateCall';
import { mediaOccupancy, type MediaClaim } from './mediaOccupancy';
import { isAuxiliaryWindow, isDesktopWindow } from './desktopAuxiliaryContext';
import { DesktopWindowChannel, prepareDesktopWindowChannel } from './desktopWindowChannel';

export type AuxiliaryContent =
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'screen'; path: string; scope: ScreenShareScope }
  | { kind: 'group'; path: string; groupId: number; deviceType: number }
  | { kind: 'private'; request?: { user: CallUser; type: 0 | 1 | 2 }; incoming?: IncomingCall };
type IncomingCall = { from: string; callId?: string; deviceType: 0 | 1 | 2; user?: CallUser };
export interface AuxiliaryBootstrap {
  content: AuxiliaryContent;
  token: string | null;
  refreshToken: string | null;
  user: ReturnType<typeof useAuthStore>['currentUser'];
  socketId: string | undefined;
  connected: boolean;
  authenticated: boolean;
}
interface Session {
  window: WebviewWindow;
  created: Promise<void>;
  channel: DesktopWindowChannel;
  content: AuxiliaryContent;
  claim: MediaClaim | null;
  ready: boolean;
  closing: boolean;
  queue: { event: string; args: unknown[] }[];
  timer: ReturnType<typeof setTimeout>;
  unlisten?: () => void;
}
const sessions = new Map<string, Session>();

function endSession(session: Session) {
  const socket = useSocketStore().socket;
  const content = session.content;
  if (content.kind === 'private') {
    const socketId = content.request?.user.socketId || content.incoming?.from;
    if (socketId) socket?.emit('webrtc_hangup', { to: { socketId } });
  } else if (content.kind === 'screen') {
    const api = createScreenShareApi(content.scope, () => socket);
    api.send('end');
    api.send('leave');
  } else if (content.kind === 'group') {
    const payload = { groupId: content.groupId, deviceType: content.deviceType };
    socket?.emit('group_call_end', payload);
    socket?.emit('leave_group_call', payload);
  }
}

function disposeSession(session: Session, graceful: boolean) {
  if (sessions.get(session.window.label) !== session) return;
  sessions.delete(session.window.label);
  clearTimeout(session.timer);
  session.unlisten?.();
  session.channel.close();
  // WebView 崩溃或启动失败时，子窗口来不及发送退出信令，由主窗口补偿。
  if (!graceful) endSession(session);
  session.claim?.release();
  if (session.content.kind === 'private') usePrivateCallStore().busy = false;
}

async function destroySession(session: Session, graceful: boolean) {
  session.closing = true;
  clearTimeout(session.timer);
  session.unlisten?.();
  session.unlisten = undefined;
  await session.window.destroy();
  disposeSession(session, graceful);
}

function requestClose(session: Session) {
  if (session.closing) return;
  session.closing = true;
  session.channel.postMessage({ type: 'close' });
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    void destroySession(session, false).catch((error) => console.error('关闭独立窗口失败', error));
  }, 3000);
}

export async function openAuxiliaryWindow(content: AuxiliaryContent) {
  const authGeneration = useAuthStore().authGeneration;
  await prepareDesktopWindowChannel();
  if (useAuthStore().authGeneration !== authGeneration || useAuthStore().loggingOut)
    throw new Error('登录状态已变化，请重试');
  const label = content.kind === 'image' ? 'image-preview' : 'media-call';
  const existing = sessions.get(label);
  if (existing) {
    if (existing.closing) throw new Error('窗口正在关闭，请稍后重试');
    if (content.kind === 'private' && content.incoming) {
      useSocketStore().socket?.emit('webrtc_call_response', {
        to: { socketId: content.incoming.from },
        accepted: false,
      });
      return;
    }
    if (content.kind === 'image') {
      existing.content = content;
      existing.channel.postMessage({ type: 'image', content });
    }
    await existing.created;
    await existing.window.unminimize();
    await existing.window.setFocus();
    return;
  }
  // 通话沿用主窗口的端点身份；重连后旧窗口会关闭，不能用未认证的 socketId 启动。
  if (content.kind !== 'image' && (!useSocketStore().authenticated || !useSocketStore().socket?.id))
    throw new Error('连接尚未就绪，请稍后重试');
  let session: Session;
  const claim =
    content.kind === 'image'
      ? null
      : mediaOccupancy.acquire(
          content.kind === 'private'
            ? 'private-call'
            : content.kind === 'screen' || content.deviceType === 2
              ? 'group-screen'
              : 'group-call',
          `window:${label}`,
          () => requestClose(session),
        );
  if (content.kind !== 'image' && !claim) throw new Error('请先结束当前通话或远程控制');
  const id = crypto.randomUUID();
  const channel = new DesktopWindowChannel(id, label);
  const path =
    content.kind === 'group' || content.kind === 'screen'
      ? content.path
      : `/desktop-${content.kind}`;
  const child = new WebviewWindow(label, {
    url: `index.html?auxiliary=${id}#${path}`,
    title: content.kind === 'image' ? '图片预览 · NearLink' : '通话 · NearLink',
    width: content.kind === 'image' ? 1000 : 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    center: true,
    decorations: true,
    ...(content.kind !== 'image' ? { backgroundColor: '#0b1220', theme: 'dark' as const } : {}),
    dragDropEnabled: false,
  });
  const created = new Promise<void>((resolve, reject) => {
    void child.once('tauri://created', () => resolve()).catch(reject);
    void child
      .once('tauri://error', (event) => reject(new Error(String(event.payload))))
      .catch(reject);
  });
  session = {
    window: child,
    created,
    channel,
    content,
    claim,
    ready: false,
    closing: false,
    queue: [],
    timer: setTimeout(() => {
      void destroySession(session, false).catch((error) =>
        console.error('关闭未就绪窗口失败', error),
      );
    }, 20000),
  };
  sessions.set(label, session);
  if (content.kind === 'private') usePrivateCallStore().busy = true;
  channel.onmessage = ({ data }) => {
    if (sessions.get(label) !== session) return;
    const store = useSocketStore();
    if (data.type === 'hello') {
      // 子窗口刷新会丢失媒体对象，关闭旧会话，避免重复发起同一通话。
      if (session.ready) {
        void destroySession(session, false).catch((error) =>
          console.error('关闭刷新窗口失败', error),
        );
        return;
      }
      const auth = useAuthStore();
      const bootstrap: AuxiliaryBootstrap = {
        content: session.content,
        token: auth.token,
        refreshToken: auth.refreshToken,
        user: auth.currentUser ? JSON.parse(JSON.stringify(auth.currentUser)) : null,
        socketId: store.socket?.id,
        connected: store.connected,
        authenticated: store.authenticated,
      };
      channel.postMessage({ type: 'bootstrap', bootstrap });
    } else if (data.type === 'ready') {
      clearTimeout(session.timer);
      session.ready = true;
      if (session.closing) channel.postMessage({ type: 'close' });
      else
        for (const signal of session.queue.splice(0))
          channel.postMessage({ type: 'signal', ...signal });
    } else if (data.type === 'emit') {
      if (data.event === 'join_group') store.joinGroup(data.args[0].groupId);
      // 主窗口仍在聊天/订阅群消息，子窗口退出只离开媒体会话。
      else if (data.event !== 'leave_group' && data.event !== 'authenticate') {
        store.socket?.emit(data.event, ...data.args);
      }
    } else if (data.type === 'closed') {
      void destroySession(session, true).catch((error) => console.error('关闭独立窗口失败', error));
    } else if (data.type === 'refresh-auth') {
      const auth = useAuthStore();
      void (async () => {
        const { refreshAccessToken } = await import('@/utils/request');
        const success =
          !auth.loggingOut && (auth.token !== data.token || (await refreshAccessToken()));
        if (sessions.get(label) === session && !session.closing)
          channel.postMessage({
            type: 'refreshed-auth',
            success,
            token: auth.token,
            refreshToken: auth.refreshToken,
          });
      })();
    } else if (data.type === 'auth-failed') {
      void useAuthStore().logout({ callApi: false, navigate: true });
    }
  };
  try {
    await created;
    const unlisten = await child.once('tauri://destroyed', () => disposeSession(session, false));
    if (sessions.get(label) === session) session.unlisten = unlisten;
    else unlisten();
  } catch (error) {
    disposeSession(session, false);
    throw error;
  }
}

export async function openDesktopGroupWindow(path: string) {
  if (!isDesktopWindow || isAuxiliaryWindow) return false;
  const match = /^\/group-(video|audio|screen)\/(\d+)$/.exec(path);
  if (!match) return false;
  if (match[1] === 'screen') {
    await openAuxiliaryWindow({
      kind: 'screen',
      path,
      scope: { kind: 'group', id: Number(match[2]) },
    });
    return true;
  }
  await openAuxiliaryWindow({
    kind: 'group',
    path,
    groupId: Number(match[2]),
    deviceType: match[1] === 'screen' ? 2 : match[1] === 'audio' ? 3 : 1,
  });
  return true;
}

export function installDesktopAuxiliaryHost(onError: (error: unknown) => void) {
  const store = useSocketStore();
  const calls = usePrivateCallStore();
  const auth = useAuthStore();
  function relay(event: string, ...args: unknown[]) {
    const session = sessions.get('media-call');
    if (!session) return;
    if (session.ready) session.channel.postMessage({ type: 'signal', event, args });
    else session.queue.push({ event, args });
  }
  function incoming(data: IncomingCall) {
    if (![0, 2].includes(data.deviceType)) {
      store.socket?.emit('webrtc_call_response', { to: { socketId: data.from }, accepted: false });
      return;
    }
    const session = sessions.get('media-call');
    if (session?.content.kind === 'private') return; // 已由 relay 送给当前通话处理忙线。
    if (mediaOccupancy.current.value || session) {
      store.socket?.emit('webrtc_call_response', { to: { socketId: data.from }, accepted: false });
      return;
    }
    void openAuxiliaryWindow({ kind: 'private', incoming: data }).catch(onError);
  }
  const disconnected = () => {
    relay('disconnect');
    const session = sessions.get('media-call');
    if (session) requestClose(session);
  };
  const detach = (socket: Socket | null) => {
    socket?.offAny(relay);
    socket?.off('webrtc_call_request', incoming);
    socket?.off('disconnect', disconnected);
  };
  const stopSocket = watch(
    () => store.socket,
    (socket, previous) => {
      detach(previous || null);
      if (previous) disconnected();
      socket?.onAny(relay);
      socket?.on('webrtc_call_request', incoming);
      socket?.on('disconnect', disconnected);
    },
    { immediate: true, flush: 'sync' },
  );
  const stopRequest = watch(
    () => calls.request,
    (request) => {
      if (!request) return;
      calls.request = null;
      if (request.type === 1) {
        void openAuxiliaryWindow({
          kind: 'screen',
          path: `/screen-share/private/${request.user.id}`,
          scope: { kind: 'private', peerId: request.user.id },
        }).catch(onError);
        return;
      }
      void openAuxiliaryWindow({
        kind: 'private',
        request: JSON.parse(JSON.stringify(request)),
      }).catch(onError);
    },
    { flush: 'sync' },
  );
  const stopAuth = watch(
    () => [auth.authGeneration, auth.loggingOut],
    () => {
      for (const session of sessions.values()) requestClose(session);
    },
    { flush: 'sync' },
  );
  const stopTokens = watch(
    () => [auth.token, auth.refreshToken],
    () => {
      for (const session of sessions.values()) {
        if (!session.closing)
          session.channel.postMessage({
            type: 'auth',
            token: auth.token,
            refreshToken: auth.refreshToken,
          });
      }
    },
    { flush: 'post' },
  );
  return () => {
    stopSocket();
    stopRequest();
    stopAuth();
    stopTokens();
    detach(store.socket);
    for (const session of sessions.values()) requestClose(session);
  };
}
