import type { QueuedAudioChunk } from './audioChunkQueue';

export interface RecordingDraft {
  userId: number;
  sessionId: string;
  lastProducedAudioIndex: number;
  endIntent: boolean;
  tailComplete: boolean;
  updatedAt: number;
}

/** 只保留当前账户尚未收到持久化 ACK 的 PCM；服务端是确认点的唯一来源。 */
export class RecordingDraftStore {
  constructor(private readonly userId: number) {}

  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nearlink-meeting-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('drafts', mode);
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error ?? new Error('draft_transaction_aborted'));
        tx.onerror = () => reject(tx.error);
        action(tx.objectStore('drafts'), result => { value = result; });
      });
    } finally { db.close(); }
  }

  private key(sessionId: string) { return `${this.userId}:${sessionId}`; }

  async create(sessionId: string): Promise<void> {
    await this.transaction<void>('readwrite', (store, done) => {
      store.put({ userId: this.userId, sessionId, lastProducedAudioIndex: -1, endIntent: false,
        tailComplete: true, updatedAt: Date.now(), chunks: [] }, this.key(sessionId));
      done();
    });
  }

  async load(sessionId: string): Promise<(RecordingDraft & { chunks: QueuedAudioChunk[] }) | null> {
    return this.transaction('readonly', (store, done) => {
      const request = store.get(this.key(sessionId));
      request.onsuccess = () => done(request.result ?? null);
    });
  }

  private async update(sessionId: string, change: (draft: RecordingDraft & { chunks: QueuedAudioChunk[] }) => void): Promise<void> {
    await this.transaction<void>('readwrite', (store, done) => {
      const request = store.get(this.key(sessionId));
      request.onsuccess = () => {
        const draft = request.result;
        if (!draft) { store.transaction.abort(); return; }
        change(draft);
        draft.updatedAt = Date.now();
        store.put(draft, this.key(sessionId));
        done();
      };
    });
  }

  put(sessionId: string, chunk: QueuedAudioChunk): Promise<void> {
    return this.update(sessionId, draft => {
      draft.chunks.push(chunk);
      draft.lastProducedAudioIndex = chunk.audioIndex;
    });
  }

  confirm(sessionId: string, index: number): Promise<void> {
    return this.update(sessionId, draft => { draft.chunks = draft.chunks.filter(chunk => chunk.audioIndex > index); });
  }

  ending(sessionId: string, tailComplete: boolean): Promise<void> {
    return this.update(sessionId, draft => { draft.endIntent = true; draft.tailComplete = tailComplete; });
  }

  async remove(sessionId: string): Promise<void> {
    await this.transaction<void>('readwrite', (store, done) => { store.delete(this.key(sessionId)); done(); });
  }
}
