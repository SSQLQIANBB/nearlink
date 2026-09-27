import redis from '../config/redis';
import { RemoteDevice } from '../models/RemoteControl';
import { validateAuthenticatedSession } from './loginSessionService';
import { RedisRemoteSessionStore } from './redisRemoteSessionStore';
import { RemoteSessionHistory } from './remoteSessionHistory';
import { RemoteControlService } from './remoteControlService';
import { RemoteLiveAuthority } from './remoteLiveAuthority';
import { RemoteAuthorizationCoordinator } from './remoteAuthorizationCoordinator';
import { remoteCredentialSignerFromEnvironment } from './remoteCredentials';
import { getRemoteControlCapabilities } from './remoteControlPolicy';
import { RemoteControlError } from './remoteControlProtocol';

function createContext() {
  const store = new RedisRemoteSessionStore(redis), history = new RemoteSessionHistory();
  const service = new RemoteControlService(store, Date.now, history);
  const signer = remoteCredentialSignerFromEnvironment();
  const authority = signer ? new RemoteLiveAuthority({
    authenticate: validateAuthenticatedSession,
    device: async id => (await RemoteDevice.findByPk(id))?.get({ plain: true }) || null,
    released: async session => {
      const policy = getRemoteControlCapabilities(session.host.userId);
      if (!policy.desktopHostEnabled) throw new RemoteControlError(policy.reason, 503);
      if (!getRemoteControlCapabilities(session.controller.userId).desktopControllerEnabled) throw new RemoteControlError('NATIVE_VALIDATION_PENDING', 503);
      const host = authority?.host(session.host.endpointId);
      if (!host || !policy.releasedPlatforms.includes(host.platform) || !host.presence?.canCapture
        || (session.scope === 'control' && !host.presence.canControl)) throw new RemoteControlError('HOST_UNAVAILABLE', 503);
    },
  }, signer) : null;
  const coordinator = signer && authority ? new RemoteAuthorizationCoordinator(service, store, history, signer, authority) : null;
  return { store, history, service, signer, authority, coordinator };
}
let context: ReturnType<typeof createContext> | undefined;
/** Runtime cleanup, REST discovery and Socket admission share the same service owner. */
export function getRemoteControlContext(): ReturnType<typeof createContext> { return context ||= createContext(); }
