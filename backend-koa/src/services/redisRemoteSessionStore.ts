import type Redis from 'ioredis';
import { REMOTE_LIMITS, RemoteControlError, type RemoteSession } from './remoteControlProtocol';
import type { SessionRevocation } from './loginSessionService';

const prefix = 'remote:{remote-control}:';
const sessionKey = (id: string) => `${prefix}session:${id}`;
const endpointKey = (id: string) => `${prefix}occupied:${id}`;
const deadlinesKey = `${prefix}deadlines`;
const activeKey = `${prefix}active`;
const sidKey = (id: string) => `${prefix}sid:${id}`;
const userKey = (id: number) => `${prefix}user:${id}`;
const membershipKeys = (s: RemoteSession) => [...new Set([sidKey(s.controller.sid), sidKey(s.host.sid),
  sidKey(s.grantCreatedBySid || s.host.sid), userKey(s.controller.userId), userKey(s.host.userId), activeKey])];
const bounded = (limit: number) => Math.max(1, Math.min(100, Math.floor(limit) || 25));

export const CREATE_REMOTE_SESSION = `
local prior = redis.call('GET', KEYS[2])
if prior then
  local saved = cjson.decode(prior)
  if saved.hash ~= ARGV[2] then return {'IDEMPOTENCY_CONFLICT'} end
  return {'EXISTING', saved.id}
end
local incoming = cjson.decode(ARGV[1])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if now >= incoming.deadline or now >= incoming.hardDeadline then return {'SESSION_EXPIRED'} end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 then return {'ENDPOINT_BUSY'} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[5])
redis.call('SET', KEYS[2], cjson.encode({hash=ARGV[2], id=ARGV[3]}), 'PX', ARGV[5])
redis.call('SET', KEYS[3], ARGV[3], 'PX', ARGV[5])
redis.call('SET', KEYS[4], ARGV[3], 'PX', ARGV[5])
redis.call('ZADD', KEYS[5], ARGV[4], ARGV[3])
for n=6,#KEYS do redis.call('ZADD', KEYS[n], incoming.createdAt, incoming.id) end
return {'CREATED', ARGV[3]}
`;
export const UPDATE_REMOTE_SESSION = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'SESSION_NOT_FOUND' end
local current = cjson.decode(raw)
if current.revision ~= tonumber(ARGV[1]) then return 'REVISION_CONFLICT' end
if current.state == 'ended' then return 'SESSION_ENDED' end
local next = cjson.decode(ARGV[2])
if next.id ~= current.id then return 'INVALID_SESSION' end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if next.state ~= 'ended' and (now >= current.deadline or now >= current.hardDeadline) then return 'SESSION_EXPIRED' end
if next.state ~= 'ended' and (redis.call('GET', KEYS[2]) ~= current.id or redis.call('GET', KEYS[3]) ~= current.id) then return 'LOCK_LOST' end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
if next.state == 'ended' then
  for n=2,3 do if redis.call('GET', KEYS[n]) == current.id then redis.call('DEL', KEYS[n]) end end
  redis.call('ZREM', KEYS[4], current.id)
  redis.call('HSET', KEYS[5], current.id, ARGV[2])
  redis.call('ZADD', KEYS[6], now, current.id)
  for n=7,#KEYS do redis.call('ZREM', KEYS[n], current.id) end
else redis.call('ZADD', KEYS[4], next.deadline, current.id) end
return 'OK'
`;

export interface RemoteOutboxEntry { id: string; raw: string }
export interface RemoteRevocationJob extends SessionRevocation { afterId?: string }
export class RedisRemoteSessionStore {
  constructor(private readonly redis: Pick<Redis, 'eval' | 'get' | 'zrangebyscore'>) {}
  async occupied(endpointId: string) { return Boolean(await this.redis.get(endpointKey(endpointId))); }
  async get(id: string): Promise<RemoteSession | null> {
    const raw = await this.redis.get(sessionKey(id));
    return raw ? JSON.parse(raw) : null;
  }
  async create(session: RemoteSession): Promise<{ created: boolean; session: RemoteSession }> {
    const ttl = Math.max(1, session.hardDeadline - Date.now()) + REMOTE_LIMITS.tombstoneMs;
    const keys = [sessionKey(session.id), `${prefix}request:${session.controller.sid}:${session.requestId}`,
      endpointKey(session.controller.endpointId), endpointKey(session.host.endpointId), deadlinesKey, ...membershipKeys(session)];
    const result = await this.redis.eval(CREATE_REMOTE_SESSION, keys.length, ...keys,
      JSON.stringify(session), session.requestHash, session.id, session.deadline, ttl) as string[];
    if (result[0] === 'CREATED') return { created: true, session };
    if (result[0] === 'EXISTING') {
      const existing = await this.get(result[1]);
      if (existing) return { created: false, session: existing };
      throw new RemoteControlError('SESSION_ENDED');
    }
    throw new RemoteControlError(result[0]);
  }
  async save(previous: RemoteSession, next: RemoteSession, now: number) {
    const ttl = next.state === 'ended' ? REMOTE_LIMITS.tombstoneMs : Math.max(1, next.hardDeadline - now) + REMOTE_LIMITS.tombstoneMs;
    const keys = [sessionKey(previous.id), endpointKey(previous.controller.endpointId), endpointKey(previous.host.endpointId),
      deadlinesKey, `${prefix}outbox`, `${prefix}outbox-due`, ...membershipKeys(previous)];
    const result = await this.redis.eval(UPDATE_REMOTE_SESSION, keys.length, ...keys, previous.revision, JSON.stringify(next), ttl);
    if (result !== 'OK') throw new RemoteControlError(String(result));
    return next;
  }
  async due(now: number, limit = 25) { return this.redis.zrangebyscore(deadlinesKey, '-inf', now, 'LIMIT', 0, bounded(limit)); }

  /** A stale scanner cannot remove a newly extended deadline or a live session's index. */
  async removeDeadline(id: string, observedDueBefore: number) {
    await this.redis.eval(`local score=redis.call('ZSCORE',KEYS[1],ARGV[1])
if not score or tonumber(score)>tonumber(ARGV[2]) then return 0 end
local raw=redis.call('GET',KEYS[2])
if raw and cjson.decode(raw).state~='ended' then return 0 end
redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[3],ARGV[1]); return 1`,
    3, deadlinesKey, sessionKey(id), activeKey, id, observedDueBefore);
  }

  private async queueEntries(name: string, now: number, limit: number): Promise<RemoteOutboxEntry[]> {
    const flat = await this.redis.eval(`local ids=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1],'LIMIT',0,ARGV[2])
local result={}
for _,id in ipairs(ids) do local raw=redis.call('HGET',KEYS[1],id)
if raw then table.insert(result,id); table.insert(result,raw) else redis.call('ZREM',KEYS[2],id) end end
return result`, 2, `${prefix}${name}`, `${prefix}${name}-due`, now, bounded(limit)) as string[];
    const entries: RemoteOutboxEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) entries.push({ id: flat[i], raw: flat[i + 1] });
    return entries;
  }
  readOutbox(now = Date.now(), limit = 25) { return this.queueEntries('outbox', now, limit); }
  async outbox() { return Object.fromEntries((await this.readOutbox(Date.now(), 100)).map(entry => [entry.id, entry.raw])); }
  private async compareQueue(name: string, id: string, raw: string, retryAt?: number): Promise<boolean> {
    const result = await this.redis.eval(`if redis.call('HGET',KEYS[1],ARGV[1])~=ARGV[2] then return 0 end
if ARGV[3]~='' then redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1])
else redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]) end return 1`,
    2, `${prefix}${name}`, `${prefix}${name}-due`, id, raw, retryAt ?? '');
    return result === 1;
  }
  acknowledgeHistory(id: string, raw: string) { return this.compareQueue('outbox', id, raw); }
  deferHistory(id: string, raw: string, retryAt: number) { return this.compareQueue('outbox', id, raw, retryAt); }
  async enqueueRevocation(event: SessionRevocation, now = Date.now()) {
    const id = event.sid ? `sid:${event.sid}` : `user:${event.userId}:${event.revokedAuthVersion || 'all'}`;
    await this.redis.eval("redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]); return 1",
      2, `${prefix}revocations`, `${prefix}revocations-due`, id, JSON.stringify(event), now);
  }
  readRevocations(now = Date.now(), limit = 25) { return this.queueEntries('revocations', now, limit); }
  acknowledgeRevocation(entry: RemoteOutboxEntry) { return this.compareQueue('revocations', entry.id, entry.raw); }
  deferRevocation(entry: RemoteOutboxEntry, retryAt: number) { return this.compareQueue('revocations', entry.id, entry.raw, retryAt); }
  async advanceRevocation(entry: RemoteOutboxEntry, afterId: string) {
    const next = JSON.stringify({ ...JSON.parse(entry.raw), afterId });
    await this.redis.eval("if redis.call('HGET',KEYS[1],ARGV[1])~=ARGV[2] then return 0 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]); return 1",
      1, `${prefix}revocations`, entry.id, entry.raw, next);
  }
  /** Stable admission-order pagination remains bounded when new-version sessions are preserved. */
  async indexedSessions(event: RemoteRevocationJob | null, limit = 25) {
    const key = event ? (event.sid ? sidKey(event.sid) : userKey(event.userId)) : activeKey;
    // Scan only a bounded rank window. Entries are removed on end; preserved entries advance the cursor.
    const result = await this.redis.eval(`local offset=0
if ARGV[1]~='' then local rank=redis.call('ZRANK',KEYS[1],ARGV[1]); if rank then offset=rank+1 end end
return redis.call('ZRANGE',KEYS[1],offset,offset+tonumber(ARGV[2])-1)`, 1, key, event?.afterId || '', bounded(limit)) as string[];
    return result;
  }
  async canPruneHistory(id: string): Promise<boolean> {
    // Check the hash itself: a deferred/unindexed outbox event still protects history.
    const result = await this.redis.eval(`if redis.call('HEXISTS',KEYS[1],ARGV[1])==1 then return 0 end
local raw=redis.call('GET',KEYS[2]); if raw and cjson.decode(raw).state~='ended' then return 0 end return 1`,
    2, `${prefix}outbox`, sessionKey(id), id);
    return result === 1;
  }
  async cleanupOrphan(record: { sessionId: string; controllerSid: string; hostSid: string; grantCreatedBySid?: string | null;
    controllerUserId: number; hostUserId: number; controllerEndpointId?: string | null; hostDeviceId: string }) {
    const keys = [sessionKey(record.sessionId), deadlinesKey, activeKey, sidKey(record.controllerSid), sidKey(record.hostSid),
      sidKey(record.grantCreatedBySid || record.hostSid), userKey(record.controllerUserId), userKey(record.hostUserId),
      endpointKey(record.controllerEndpointId || ''), endpointKey(record.hostDeviceId)];
    await this.redis.eval(`if redis.call('EXISTS',KEYS[1])~=0 then return 0 end
for n=2,8 do redis.call('ZREM',KEYS[n],ARGV[1]) end
for n=9,10 do if redis.call('GET',KEYS[n])==ARGV[1] then redis.call('DEL',KEYS[n]) end end return 1`,
    keys.length, ...keys, record.sessionId);
  }
  async removeStaleIndex(event: RemoteRevocationJob | null, id: string) {
    const key = event ? (event.sid ? sidKey(event.sid) : userKey(event.userId)) : activeKey;
    await this.redis.eval("local raw=redis.call('GET',KEYS[2]); if not raw or cjson.decode(raw).state=='ended' then return redis.call('ZREM',KEYS[1],ARGV[1]) end return 0", 2, key, sessionKey(id), id);
  }
}
