import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindRemoteInputSafety, RemoteInputSender, remoteVideoCoordinates, remoteWheelPixels, type RemoteInputMessage } from '@/services/remoteControlInput';
import type { RemoteControlGeometry } from '@/services/remoteControlGeometry';

const context = { sessionId: 'session', controlEpoch: 1, inputEpoch: 2, layoutVersion: 3 };
const windowTicket = { ...context, inputWindowId: 'ticket-1' };
let now = 0;
const send = vi.fn();
const stop = vi.fn();
const transport = { readyState: 'open', bufferedAmount: 0, send };
let sender: RemoteInputSender;
const move = (x: number) => ({ type: 'move' as const, payload: { x, y: 0.5 } });
const button = { type: 'button' as const, payload: { x: 0.9, y: 0.5, button: 0 as const, down: true } };
const sent = () => send.mock.calls.map(([data]) => JSON.parse(data) as RemoteInputMessage);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  now = 0;
  transport.bufferedAmount = 0;
  transport.readyState = 'open';
  sender = new RemoteInputSender(transport, stop, () => now);
  sender.arm(context);
  sender.acceptWindow(windowTicket);
});
afterEach(() => { sender.dispose(); vi.useRealTimers(); });

describe('远控可靠输入协议', () => {
  it('合并移动但离散点击前必须发送最新坐标，并在实际发送时分配连续序号', () => {
    sender.enqueue(move(0.1));
    now = 1;
    sender.enqueue(move(0.2));
    sender.enqueue(move(0.9));
    sender.enqueue(button);
    expect(sent().map(message => message.seq)).toEqual([1, 2, 3]);
    expect(sent().map(message => message.type)).toEqual(['move', 'move', 'button']);
    expect(sent()[1]?.payload).toEqual({ x: 0.9, y: 0.5 });
  });
  it('排队事件保留产生时票据，不能被新票据续命', () => {
    sender.enqueue(move(0.1));
    now = 1;
    sender.enqueue(move(0.2));
    sender.acceptWindow({ ...windowTicket, inputWindowId: 'ticket-2' });
    now = 40;
    sender.tick();
    expect(sent()[1]?.inputWindowId).toBe('ticket-1');
  });
  it('旧代次与布局票据不能打开输入，过期票据暂停并要求独立释放', () => {
    expect(sender.acceptWindow({ ...windowTicket, inputEpoch: 1 })).toBe(false);
    expect(sender.acceptWindow({ ...windowTicket, layoutVersion: 2 })).toBe(false);
    now = 500;
    expect(sender.enqueue(button)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith('INPUT_WINDOW_EXPIRED', context);
  });
  it('重复票据不刷新有效年龄', () => {
    now = 400;
    sender.acceptWindow(windowTicket);
    now = 501;
    expect(sender.enqueue(button)).toBe(false);
  });
  it('64 KiB积压立即关闭门禁，恢复也不补发旧点击或重用代次', () => {
    transport.bufferedAmount = 64 * 1024 + 1;
    expect(sender.enqueue(button)).toBe(false);
    expect(stop).toHaveBeenCalledWith('INPUT_BACKPRESSURE', context);
    transport.bufferedAmount = 0;
    expect(sender.arm(context)).toBe(false);
    expect(sender.enqueue(button)).toBe(false);
    expect(sender.arm({ ...context, inputEpoch: 3 })).toBe(true);
    expect(sender.enqueue(button)).toBe(false); // New epoch needs a fresh ticket.
    expect(send).not.toHaveBeenCalled();
  });
  it('离散输入ACK迟到500ms关闭输入；旧代次ACK无效', () => {
    sender.enqueue(button);
    expect(sender.acknowledge({ ...context, seq: 1, inputEpoch: 1 })).toBe(false);
    now = 500;
    sender.tick();
    expect(sender.armed).toBe(false);
    expect(stop).toHaveBeenCalledWith('INPUT_ACK_TIMEOUT', context);
  });
  it('有效ACK清理等待队列但未来序号不能伪造ACK', () => {
    sender.enqueue(button);
    expect(sender.acknowledge({ ...context, seq: 2 })).toBe(false);
    expect(sender.acknowledge({ ...context, seq: 1 })).toBe(true);
    now = 500;
    sender.tick();
    expect(sender.armed).toBe(true);
  });
  it('失焦清理按键且focus事件不自动恢复', () => {
    const surface = document.createElement('div');
    const dispose = bindRemoteInputSafety(sender, surface);
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(sender.armed).toBe(false);
    expect(stop).toHaveBeenCalledWith('CONTROLLER_BLURRED', context);
    dispose();
  });
  it('文本按码点限额并受UTF-8字节限制，IME commit只发送一次', () => {
    const commit = { type: 'text' as const, payload: { text: '中文👋', commitId: 'ime-1' } };
    expect(sender.enqueue(commit)).toBe(true);
    expect(sender.enqueue(commit)).toBe(false);
    expect(sent()).toHaveLength(1);
    expect(sender.enqueue({ type: 'text', payload: { text: '😀'.repeat(1024), commitId: 'ime-2' } })).toBe(false);
    expect(stop).toHaveBeenCalledWith('INPUT_MESSAGE_TOO_LARGE', context);
  });
  it('拒绝未知按键和越界坐标', () => {
    expect(sender.enqueue({ type: 'key', payload: { code: 'ShellCommand', down: true } })).toBe(false);
    expect(sender.enqueue(move(NaN))).toBe(false);
    expect(sender.enqueue(move(1.1))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('远控画面坐标', () => {
  it('映射contain后的真实画面而非黑边，并与编码尺寸比例一致', () => {
    const rect = { left: 10, top: 20, width: 1000, height: 1000 };
    const geometry = (width: number, height: number): RemoteControlGeometry => ({ displayId: 1, coordinateSpace: 'quartz-global-logical', displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, displayPixels: { width: 1920, height: 1080 }, rotationDegrees: 0, encodedSize: { width, height }, contentRect: { x: 0, y: 0, width, height } });
    expect(remoteVideoCoordinates(510, 520, rect, 1920, 1080, geometry(1920, 1080))).toEqual({ x: 0.5, y: 0.5 });
    expect(remoteVideoCoordinates(510, 100, rect, 1920, 1080, geometry(1920, 1080))).toBeNull();
    expect(remoteVideoCoordinates(510, 520, rect, 1280, 720, geometry(1280, 720))).toEqual({ x: 0.5, y: 0.5 });
    expect(remoteVideoCoordinates(510, 520, rect, 0, 0, geometry(1280, 720))).toBeNull();
    // A 150% surface scrolled left/up must still target the same remote pixel.
    expect(remoteVideoCoordinates(460, 440, { left: -500, top: -100, width: 1920, height: 1080 }, 1280, 720, geometry(1280, 720))).toEqual({ x: 0.5, y: 0.5 });
  });
  it('转换line/page滚轮为有界CSS像素', () => {
    expect(remoteWheelPixels(3, 1, 1000)).toBe(48);
    expect(remoteWheelPixels(-1, 2, 1000)).toBe(-1000);
    expect(remoteWheelPixels(100, 2, 1000)).toBe(2000);
    expect(remoteWheelPixels(Infinity, 0, 1000)).toBe(0);
  });
});
