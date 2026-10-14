import { createRequestId } from '@/utils/requestId';
import type { RemoteInputEvent } from './remoteControlInput';

/** One explicit text submit may wait at most 500 ms for its newly armed input window. */
export class RemoteTextCommitQueue {
  private pending: {
    event: Extract<RemoteInputEvent, { type: 'text' }>;
    createdAt: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (sent: boolean) => void;
  } | null = null;
  constructor(private readonly now: () => number = () => performance.now()) {}
  submit(text: string, requestArm: () => boolean) {
    this.cancel();
    if (!text || [...text].length > 1024) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const event = { type: 'text' as const, payload: { text, commitId: createRequestId() } };
      this.pending = {
        event,
        createdAt: this.now(),
        timer: setTimeout(() => this.cancel(), 500),
        resolve,
      };
      if (!requestArm()) this.cancel();
    });
  }
  windowAvailable(send: (event: Extract<RemoteInputEvent, { type: 'text' }>) => boolean) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    const valid = this.now() - pending.createdAt < 500;
    pending.resolve(valid && send(pending.event));
  }
  cancel() {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
  }
}
