import { emitTo, listen } from '@tauri-apps/api/event';

// 使用 Tauri IPC，避免依赖旧版 WKWebView 尚不支持的 BroadcastChannel。
const receivers = new Map<string, (data: any) => void>();
let listening: Promise<unknown> | undefined;
export function prepareDesktopWindowChannel() {
  listening ??= listen<{ id: string; data: unknown }>('nearlink-auxiliary', ({ payload }) => {
    receivers.get(payload.id)?.(payload.data);
  });
  return listening;
}

export class DesktopWindowChannel {
  onmessage: ((event: { data: any }) => void) | null = null;
  private pending = Promise.resolve();
  constructor(
    private id: string,
    private target: string,
  ) {
    receivers.set(id, (data) => this.onmessage?.({ data }));
  }
  postMessage(data: unknown) {
    // 信令按发送顺序串行交给原生层，保证挂断先于 closed 到达主窗口。
    this.pending = this.pending.then(() =>
      emitTo(this.target, 'nearlink-auxiliary', { id: this.id, data }),
    );
    this.pending.catch((error) => console.error('窗口通信失败', error));
  }
  close() {
    receivers.delete(this.id);
  }
}
