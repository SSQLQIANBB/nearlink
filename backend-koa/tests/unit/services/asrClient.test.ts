import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 可脚本化的 WebSocket mock（覆盖 open 握手、消息、finish 与关闭）。 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Array<string | Buffer> = [];
  url: string;

  constructor(public fullUrl: string, public protocol?: string) {
    this.url = fullUrl;
    MockWebSocket.instances.push(this);
  }

  send(data: string | Buffer): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
  simulateError(): void {
    this.onerror?.();
  }
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function setEnv(opts: {
  asrUrl?: string | null;
  tencentAppId?: string;
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentEngine?: string;
}): void {
  process.env.MEETINGS_ASR_URL = opts.asrUrl ?? '';
  process.env.TENCENT_ASR_APP_ID = opts.tencentAppId ?? '';
  process.env.TENCENT_ASR_SECRET_ID = opts.tencentSecretId ?? '';
  process.env.TENCENT_ASR_SECRET_KEY = opts.tencentSecretKey ?? '';
  process.env.TENCENT_ASR_ENGINE = opts.tencentEngine ?? '16k_zh';
}

async function loadClient() {
  vi.resetModules();
  const mod = await import('../../../src/services/asrClient');
  return mod;
}

// ---- sherpa-onnx 后端测试 ----

describe('AsrClient — sherpa 后端（mock WebSocket）', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  it('未配置时 available=false，open 抛出 ASR_NOT_CONFIGURED', async () => {
    setEnv({ asrUrl: null });
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    expect(client.available).toBe(false);
    expect(client.backend).toBe('none');
    await expect(client.open({ onSegment: vi.fn(), onFault: vi.fn() })).rejects.toThrow('ASR_NOT_CONFIGURED');
  });

  it('sherpa 配置时 backend=sherpa，连接成功后按序转发 PCM', async () => {
    setEnv({ asrUrl: 'ws://asr.test:10095' });
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    expect(client.available).toBe(true);
    expect(client.backend).toBe('sherpa');
    const segments: unknown[] = [];
    const opening = client.open({
      onSegment: (s) => segments.push(s),
      onFault: vi.fn(),
    });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const handle = await opening;
    ws.simulateMessage(JSON.stringify({ segmentId: 1, text: '你好', isFinal: false, startMs: 0, endMs: null, speakerId: null }));
    expect(segments).toEqual([
      { segmentId: 1, text: '你好', isFinal: false, startMs: 0, endMs: null, speakerId: null },
    ]);
    await handle.sendPcm(Buffer.from([1, 2, 3, 4]));
    expect(ws.sent).toHaveLength(1);
    expect(Buffer.isBuffer(ws.sent[0])).toBe(true);
    handle.close();
  });

  it('sherpa finish 等待 isInputDone 后才 resolve；超时则 reject', async () => {
    vi.useFakeTimers();
    setEnv({ asrUrl: 'ws://asr.test:10095' });
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const opening = client.open({ onSegment: vi.fn(), onFault: vi.fn() });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const handle = await opening;
    const finishing = handle.finish();
    const result = finishing.then(() => 'resolved', (error: Error) => `rejected:${error.message}`);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBe('rejected:ASR_FINISH_TIMEOUT');
    handle.close();
  });

  it('sherpa finish 收到 isInputDone 即 resolve', async () => {
    setEnv({ asrUrl: 'ws://asr.test:10095' });
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const opening = client.open({ onSegment: vi.fn(), onFault: vi.fn() });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const handle = await opening;
    const finishing = handle.finish();
    ws.simulateMessage(JSON.stringify({ isInputDone: true }));
    await expect(finishing).resolves.toBeUndefined();
    expect(ws.sent.some((d) => d === JSON.stringify({ is_speaking: false }))).toBe(true);
    handle.close();
  });

  it('连接失败时 open reject 并终结等待者', async () => {
    setEnv({ asrUrl: 'ws://asr.test:10095' });
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const faults: unknown[] = [];
    const opening = client.open({ onSegment: vi.fn(), onFault: (e) => faults.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateError();
    await expect(opening).rejects.toThrow('ASR_CONNECT_FAILED');
    expect(faults.length).toBeGreaterThan(0);
  });
});

// ---- 腾讯云后端测试 ----

describe('AsrClient — 腾讯云后端（mock WebSocket）', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  const tencentEnv = {
    tencentAppId: '1234567890',
    tencentSecretId: 'AKIDtest1234567890abcdefghij',
    tencentSecretKey: 'testkey1234567890abcdefghij',
    tencentEngine: '16k_zh',
  };

  it('腾讯云三项凭据齐全时 backend=tencent', async () => {
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    expect(client.available).toBe(true);
    expect(client.backend).toBe('tencent');
  });

  it('腾讯云优先于 sherpa', async () => {
    setEnv({ ...tencentEnv, asrUrl: 'ws://asr.test:10095' });
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    expect(client.backend).toBe('tencent');
  });

  it('连接 URL 包含签名参数', async () => {
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const opening = client.open({ onSegment: vi.fn(), onFault: vi.fn() });
    const ws = MockWebSocket.instances[0];
    const url = new URL(ws.fullUrl);
    expect(url.origin + url.pathname).toBe('wss://asr.cloud.tencent.com/asr/v2/1234567890');
    expect(url.searchParams.get('engine_model_type')).toBe('16k_zh');
    expect(url.searchParams.get('voice_format')).toBe('1');
    const signature = url.searchParams.get('signature');
    url.searchParams.delete('signature');
    expect(signature).toBe(
      createHmac('sha1', tencentEnv.tencentSecretKey).update(url.host + url.pathname + url.search).digest('base64'),
    );
    // 鉴权成功后才能使用
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ code: 0, voice_id: new URL(ws.url).searchParams.get('voice_id') }));
    const handle = await opening;
    handle.close();
  });

  it('鉴权成功后接收临时句和最终句（按 index 更新，slice_type=2 落定）', async () => {
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const segments: unknown[] = [];
    const opening = client.open({
      onSegment: (s) => segments.push(s),
      onFault: vi.fn(),
    });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ code: 0, voice_id: new URL(ws.url).searchParams.get('voice_id') }));
    const handle = await opening;

    // 临时句（slice_type=0）
    ws.simulateMessage(JSON.stringify({ code: 0, result: { index: 1, voice_text_str: '你好', slice_type: 0 } }));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ segmentId: 1, text: '你好', isFinal: false });

    // 同一句的更新（slice_type=1 仍为临时结果）
    ws.simulateMessage(JSON.stringify({ code: 0, result: { index: 1, voice_text_str: '你好世界', slice_type: 1 } }));
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ segmentId: 1, text: '你好世界', isFinal: false });

    // 最终句（slice_type=2）
    ws.simulateMessage(JSON.stringify({ code: 0, result: { index: 1, voice_text_str: '你好世界。', slice_type: 2 } }));
    expect(segments).toHaveLength(3);
    expect(segments[2]).toMatchObject({ segmentId: 1, text: '你好世界。', isFinal: true });

    handle.close();
  });

  it('鉴权失败时 open reject', async () => {
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const onFault = vi.fn();
    const opening = client.open({ onSegment: vi.fn(), onFault });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ code: 50001, message: 'Auth.Failed' }));
    await expect(opening).rejects.toThrow('TENCENT_ASR_ERROR_50001');
    expect(onFault).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('finish 发送结束帧，只在收到顶层 final:1 后完成', async () => {
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const onSegment = vi.fn();
    const onFault = vi.fn();
    const opening = client.open({ onSegment, onFault });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ code: 0, voice_id: new URL(ws.url).searchParams.get('voice_id') }));
    const handle = await opening;
    await handle.sendPcm(Buffer.from([0, 0]));
    const finishing = handle.finish();
    expect(handle.finish()).toBe(finishing);
    await vi.waitFor(() => expect(ws.sent).toContain(JSON.stringify({ type: 'end' })));
    const onFinished = vi.fn();
    void finishing.then(onFinished);
    ws.simulateMessage(JSON.stringify({
      code: 0, result: { index: 1, voice_text_str: '最终', slice_type: 2, start_time: 0, end_time: 20 },
    }));
    await Promise.resolve();
    expect(onSegment).toHaveBeenCalledWith(expect.objectContaining({ text: '最终', isFinal: true }));
    expect(onFinished).not.toHaveBeenCalled();
    ws.simulateMessage(JSON.stringify({ code: 0, final: 1 }));
    await expect(finishing).resolves.toBeUndefined();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(onFault).not.toHaveBeenCalled();
  });

  it('finish 超时 reject', async () => {
    vi.useFakeTimers();
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const opening = client.open({ onSegment: vi.fn(), onFault: vi.fn() });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ code: 0, voice_id: new URL(ws.url).searchParams.get('voice_id') }));
    const handle = await opening;
    await handle.sendPcm(Buffer.from([0, 0]));
    const finishing = handle.finish();
    const result = finishing.then(() => 'resolved', (error: Error) => `rejected:${error.message}`);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBe('rejected:ASR_FINISH_TIMEOUT');
    handle.close();
  });

  it('上游断开时触发 onFault', async () => {
    setEnv(tencentEnv);
    const { AsrClient } = await loadClient();
    const client = new AsrClient();
    const faults: unknown[] = [];
    const opening = client.open({ onSegment: vi.fn(), onFault: (e) => faults.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ code: 0, voice_id: new URL(ws.url).searchParams.get('voice_id') }));
    const handle = await opening;
    ws.simulateClose();
    expect(faults.length).toBeGreaterThan(0);
    handle.close();
  });
});

// ---- 配置校验测试 ----

describe('AsrClient — 配置优先级', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('只配 sherpa 时 backend=sherpa', async () => {
    setEnv({ asrUrl: 'ws://asr.test:10095' });
    const { AsrClient } = await loadClient();
    expect(new AsrClient().backend).toBe('sherpa');
  });

  it('都不配时 backend=none', async () => {
    setEnv({});
    const { AsrClient } = await loadClient();
    expect(new AsrClient().backend).toBe('none');
  });
});
