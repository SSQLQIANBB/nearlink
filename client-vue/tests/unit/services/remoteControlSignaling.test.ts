import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteSignalClient,
  type RemoteSignalAck,
  type RemoteSignalEnvelope,
} from '@/services/remoteControlSignaling';
let acknowledgements: Array<(value: unknown) => void>;
let envelopes: RemoteSignalEnvelope[];
const stop = vi.fn();
const state = vi.fn();
const disconnect = vi.fn();
let client: RemoteSignalClient;
const ack: RemoteSignalAck = { ok: true, sessionId: 'session-1', revision: 0, state: 'pending' };
const snapshot = {
  sessionId: 'session-1',
  revision: 1,
  state: 'active',
  scope: 'control',
  authorizationRevision: 1,
  controlEpoch: 1,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  acknowledgements = [];
  envelopes = [];
  client = new RemoteSignalClient(
    {
      connected: true,
      disconnect,
      emit: (_event, envelope, acknowledge) => {
        envelopes.push(envelope);
        acknowledgements.push(acknowledge);
      },
    },
    1,
    stop,
    state,
  );
});
afterEach(() => {
  client.invalidate('TEST_END');
  vi.useRealTimers();
});
async function requested() {
  const pending = client.command('remote:request', { targetDeviceId: 'target', scope: 'view' });
  acknowledgements[0]!(ack);
  await pending;
}

describe('远控信令基础', () => {
  it('使用独立envelope，ACK本身不提升本地控制权限', async () => {
    await requested();
    expect(envelopes[0]).toMatchObject({
      protocolVersion: 1,
      connectionGeneration: 1,
      payload: { targetDeviceId: 'target', scope: 'view' },
    });
    expect(envelopes[0]?.requestId).toBeTruthy();
    expect(state).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it('首次ACK前不允许第二个请求；ACK版本用于随后立即取消', async () => {
    const first = client.command('remote:request', {});
    await expect(client.command('remote:request', {})).rejects.toThrow('REMOTE_SESSION_BUSY');
    acknowledgements[0]!(ack);
    await first;
    const cancel = client.command('remote:cancel', {});
    expect(envelopes[1]).toMatchObject({ sessionId: 'session-1', expectedRevision: 0 });
    acknowledgements[1]!({ ...ack, revision: 1, state: 'ended' });
    await cancel;
  });
  it('connectionGeneration必须是正整数，状态CAS冲突失败关闭', async () => {
    expect(
      () => new RemoteSignalClient({ connected: true, disconnect, emit: vi.fn() }, 0, stop, state),
    ).toThrow('REMOTE_INVALID_CONFIGURATION');
    await requested();
    const pause = client.command('remote:pause', {});
    acknowledgements[1]!({ ok: false, code: 'REVISION_CONFLICT' });
    await expect(pause).rejects.toThrow('REVISION_CONFLICT');
    expect(stop).toHaveBeenCalledWith('REVISION_CONFLICT');
  });
  it('ACK超时先停止本地并断开，迟到成功不会复活会话', async () => {
    const pending = client.command('remote:request', {});
    const rejection = expect(pending).rejects.toThrow('REMOTE_ACK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
    acknowledgements[0]!(ack);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await expect(client.command('remote:request', {})).rejects.toThrow('REMOTE_DISCONNECTED');
  });
  it('缺少必需会话ID的成功ACK失败关闭', async () => {
    const pending = client.command('remote:request', {});
    acknowledgements[0]!({ ok: true });
    await expect(pending).rejects.toThrow('REMOTE_INVALID_ACK');
    expect(stop).toHaveBeenCalledWith('REMOTE_INVALID_ACK');
  });
  it('只接受当前会话的新revision，终止状态不可恢复', async () => {
    await requested();
    expect(client.receiveState({ ...snapshot, sessionId: 'other' })).toBe(false);
    expect(client.receiveState(snapshot)).toBe(true);
    expect(client.receiveState({ ...snapshot, revision: 0, scope: 'view' })).toBe(false);
    expect(client.receiveState({ ...snapshot, revision: 2, state: 'ended' })).toBe(true);
    expect(client.receiveState({ ...snapshot, revision: 3 })).toBe(false);
    expect(stop).toHaveBeenCalledWith('SESSION_ENDED');
  });
  it('撤销拒绝停止所有等待操作，不接受旧代次ACK', async () => {
    await requested();
    client.receiveState(snapshot);
    const pending = client.command('remote:lease', {});
    const another = client.command('remote:pause', {});
    acknowledgements[1]!({ ok: false, code: 'AUTH_REVOKED' });
    await expect(pending).rejects.toThrow('AUTH_REVOKED');
    await expect(another).rejects.toThrow('AUTH_REVOKED');
    expect(envelopes[1]).toMatchObject({ sessionId: 'session-1', expectedRevision: 1 });
    acknowledgements[2]!({ ...ack, state: 'active' });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
