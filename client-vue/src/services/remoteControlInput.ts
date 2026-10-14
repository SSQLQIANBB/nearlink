import { registerRemoteControlCleanup } from './remoteControlSafety';
import type { RemoteControlGeometry } from './remoteControlGeometry';

/** Controller-side protocol foundation. Native lease/consent validation remains authoritative. */
export const REMOTE_INPUT_CHANNEL = { label: 'rc-input-v1', options: { ordered: true } } as const;
const MAX_BUFFER = 64 * 1024;
const MAX_EVENT_AGE = 500;
const MOVE_INTERVAL = 1000 / 30;

export interface RemoteInputContext {
  sessionId: string;
  controlEpoch: number;
  inputEpoch: number;
  layoutVersion: number;
}
export interface RemoteInputWindow extends RemoteInputContext {
  inputWindowId: string;
}
export type RemoteInputEvent =
  | { type: 'move'; payload: { x: number; y: number } }
  | { type: 'button'; payload: { x: number; y: number; button: 0 | 1 | 2; down: boolean } }
  | {
      type: 'wheel';
      payload: { x: number; y: number; deltaX: number; deltaY: number; unit: 'css-pixel' };
    }
  | { type: 'key'; payload: { code: string; down: boolean } }
  | { type: 'text'; payload: { text: string; commitId: string } };
export type RemoteInputMessage = RemoteInputContext &
  RemoteInputEvent & { version: 1; inputWindowId: string; seq: number };
export interface InputTransport {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
}
interface QueuedInput {
  event: RemoteInputEvent;
  windowId: string;
  createdAt: number;
}

function inUnit(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
function validInput(event: RemoteInputEvent) {
  if ('x' in event.payload && (!inUnit(event.payload.x) || !inUnit(event.payload.y))) return false;
  switch (event.type) {
    case 'move':
      return true;
    case 'button':
      return [0, 1, 2].includes(event.payload.button) && typeof event.payload.down === 'boolean';
    case 'wheel':
      return (
        event.payload.unit === 'css-pixel' &&
        [event.payload.deltaX, event.payload.deltaY].every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 2000,
        )
      );
    case 'key':
      return /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|F(?:[1-9]|1[0-2])|(?:Control|Shift|Alt|Meta)(?:Left|Right)|Arrow(?:Up|Down|Left|Right)|Enter|Space|Backspace|Delete|Tab|Escape|Home|End|PageUp|PageDown|Insert|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/.test(
        event.payload.code,
      );
    case 'text':
      return (
        !!event.payload.commitId &&
        event.payload.commitId.length <= 128 &&
        event.payload.text.length > 0 &&
        [...event.payload.text].length <= 1024
      );
  }
}

/** One channel, continuous sequence numbers, original event tickets, no replay after a pause. */
export class RemoteInputSender {
  private context: RemoteInputContext | null = null;
  private ticket: { id: string; receivedAt: number } | null = null;
  private pendingMove: QueuedInput | null = null;
  private pendingAcks = new Map<number, number>();
  private seq = 0;
  private lastMoveAt = -Infinity;
  private lastInputEpoch = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private committed = new Set<string>();
  private readonly unregisterCleanup: () => void;

  constructor(
    private readonly transport: InputTransport,
    private readonly stop: (reason: string, context: RemoteInputContext) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly maxMessageBytes = 4096,
  ) {
    this.unregisterCleanup = registerRemoteControlCleanup((reason) => this.pause(reason));
  }

  get armed() {
    return this.context !== null;
  }

  /** Call only after a new input-arm acknowledgement; focus alone never calls this. */
  arm(context: RemoteInputContext) {
    const previous = this.lastInputEpoch.get(context.sessionId) ?? -1;
    if (
      this.context ||
      !context.sessionId ||
      context.inputEpoch <= previous ||
      ![context.controlEpoch, context.inputEpoch, context.layoutVersion].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      this.transport.readyState !== 'open'
    )
      return false;
    this.context = { ...context };
    this.lastInputEpoch.set(context.sessionId, context.inputEpoch);
    this.seq = 0;
    this.lastMoveAt = -Infinity;
    this.committed.clear();
    this.heartbeat = setInterval(() => this.tick(), 25);
    return true;
  }

  acceptWindow(window: RemoteInputWindow) {
    const context = this.context;
    if (
      !context ||
      !window.inputWindowId ||
      window.inputWindowId.length > 128 ||
      window.sessionId !== context.sessionId ||
      window.controlEpoch !== context.controlEpoch ||
      window.inputEpoch !== context.inputEpoch ||
      window.layoutVersion !== context.layoutVersion
    )
      return false;
    // Re-delivering a ticket must never reset its local age.
    if (this.ticket?.id === window.inputWindowId) return true;
    this.ticket = { id: window.inputWindowId, receivedAt: this.now() };
    return true;
  }

  enqueue(event: RemoteInputEvent) {
    if (!this.context || !validInput(event)) return false;
    if (!this.ticket || this.now() - this.ticket.receivedAt >= MAX_EVENT_AGE) {
      this.pause('INPUT_WINDOW_EXPIRED');
      return false;
    }
    if (event.type === 'text' && this.committed.has(event.payload.commitId)) return false;
    const queued = { event, windowId: this.ticket.id, createdAt: this.now() };
    if (event.type === 'move') {
      this.pendingMove = queued;
      this.tick();
      return this.armed;
    }
    if (!this.flushMove()) return false;
    if (event.type === 'text') this.committed.add(event.payload.commitId);
    return this.send(queued);
  }

  acknowledge(ack: RemoteInputContext & { seq: number }) {
    const { seq } = ack;
    if (
      !this.context ||
      ack.sessionId !== this.context.sessionId ||
      ack.controlEpoch !== this.context.controlEpoch ||
      ack.inputEpoch !== this.context.inputEpoch ||
      ack.layoutVersion !== this.context.layoutVersion ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq > this.seq
    )
      return false;
    for (const id of this.pendingAcks.keys()) if (id <= seq) this.pendingAcks.delete(id);
    return true;
  }

  tick() {
    if (!this.context) return;
    if (this.transport.readyState !== 'open') {
      this.pause('CHANNEL_CLOSED');
      return;
    }
    if (this.transport.bufferedAmount > MAX_BUFFER) {
      this.pause('INPUT_BACKPRESSURE');
      return;
    }
    const oldest = this.pendingAcks.values().next().value;
    if (oldest !== undefined && this.now() - oldest >= MAX_EVENT_AGE) {
      this.pause('INPUT_ACK_TIMEOUT');
      return;
    }
    if (this.pendingMove && this.now() - this.lastMoveAt >= MOVE_INTERVAL) this.flushMove();
  }

  pause(reason: string) {
    const context = this.context;
    this.context = null;
    this.ticket = null;
    this.pendingMove = null;
    this.pendingAcks.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    // This uses the independent state/stop path, never the congested input queue.
    if (context) this.stop(reason, context);
  }

  dispose() {
    this.pause('CONTROLLER_DISPOSED');
    this.unregisterCleanup();
  }

  private flushMove() {
    const move = this.pendingMove;
    this.pendingMove = null;
    return move ? this.send(move) : true;
  }

  private send(queued: QueuedInput) {
    const context = this.context;
    if (!context) return false;
    if (this.now() - queued.createdAt >= MAX_EVENT_AGE) {
      this.pause('INPUT_EVENT_EXPIRED');
      return false;
    }
    if (this.transport.readyState !== 'open' || this.transport.bufferedAmount > MAX_BUFFER) {
      this.pause('INPUT_BACKPRESSURE');
      return false;
    }
    const message: RemoteInputMessage = {
      version: 1,
      ...context,
      ...queued.event,
      inputWindowId: queued.windowId,
      seq: this.seq + 1,
    };
    const encoded = JSON.stringify(message);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (this.transport.bufferedAmount + bytes > MAX_BUFFER) {
      this.pause('INPUT_BACKPRESSURE');
      return false;
    }
    if (bytes > Math.min(4096, this.maxMessageBytes)) {
      this.pause('INPUT_MESSAGE_TOO_LARGE');
      return false;
    }
    try {
      this.transport.send(encoded);
    } catch {
      this.pause('INPUT_SEND_FAILED');
      return false;
    }
    this.seq++;
    if (queued.event.type === 'move') this.lastMoveAt = this.now();
    else this.pendingAcks.set(this.seq, queued.createdAt);
    return true;
  }
}

/** Remove CSS letterboxing and encoded padding. DPI and rotation are already
 * reflected in the visible content; the native side maps its normalized position. */
export function remoteVideoCoordinates(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number,
  geometry: RemoteControlGeometry | null,
) {
  if (
    !geometry ||
    videoWidth !== geometry.encodedSize.width ||
    videoHeight !== geometry.encodedSize.height ||
    ![clientX, clientY, rect.left, rect.top].every(Number.isFinite) ||
    ![rect.width, rect.height, videoWidth, videoHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  const encodedX = (clientX - rect.left - (rect.width - width) / 2) / scale;
  const encodedY = (clientY - rect.top - (rect.height - height) / 2) / scale;
  const x = (encodedX - geometry.contentRect.x) / geometry.contentRect.width;
  const y = (encodedY - geometry.contentRect.y) / geometry.contentRect.height;
  return inUnit(x) && inUnit(y) ? { x, y } : null;
}

export function remoteWheelPixels(
  delta: number,
  mode: number,
  pageHeight: number,
  lineHeight = 16,
) {
  if (![delta, pageHeight, lineHeight].every(Number.isFinite) || ![0, 1, 2].includes(mode))
    return 0;
  const converted = delta * (mode === 1 ? lineHeight : mode === 2 ? pageHeight : 1);
  return Math.max(-2000, Math.min(2000, converted));
}

/** Focus loss only closes input. A new explicit input-arm handshake is needed to resume. */
export function bindRemoteInputSafety(
  sender: RemoteInputSender,
  surface: HTMLElement,
  hostWindow: Window = window,
  hostDocument: Document = document,
) {
  const blur = () => sender.pause('CONTROLLER_BLURRED');
  const hidden = () => {
    if (hostDocument.hidden) sender.pause('CONTROLLER_HIDDEN');
  };
  const captureLost = () => sender.pause('POINTER_CAPTURE_LOST');
  hostWindow.addEventListener('blur', blur);
  hostDocument.addEventListener('visibilitychange', hidden);
  surface.addEventListener('blur', blur);
  surface.addEventListener('lostpointercapture', captureLost);
  return () => {
    hostWindow.removeEventListener('blur', blur);
    hostDocument.removeEventListener('visibilitychange', hidden);
    surface.removeEventListener('blur', blur);
    surface.removeEventListener('lostpointercapture', captureLost);
    sender.dispose();
  };
}
