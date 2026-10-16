import { http, request } from '@/utils/request';

export type RemotePlatform = 'windows' | 'macos';
export interface RemoteAssistanceCredentials {
  deviceCode: string;
  temporaryPassword: string;
}
export interface RemoteControlRelease {
  protocolVersion: number;
  desktopControllerEnabled: boolean;
  desktopHostEnabled: boolean;
  webControllerReleaseEnabled: boolean;
  releasedPlatforms: RemotePlatform[];
  engineRequired: boolean;
}
export interface RemoteTarget {
  deviceId: string;
  alias: string;
  platform: string;
  online: boolean;
  busy: boolean;
  canHostView: boolean;
  canHostControl: boolean;
}
export interface RemoteSessionRecord {
  sessionId: string;
  state: 'pending' | 'connecting' | 'active' | 'ended';
  revision: number;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
  hostDeviceId?: string;
  scope?: 'view' | 'control';
}

export interface RemoteDevice {
  deviceId: string;
  alias: string;
  platform: RemotePlatform;
  revokedAt: string | null;
  createdAt: string;
}
export interface RemoteDeviceChallenge {
  id: string;
  nonce: string;
  userId: number;
  sid: string;
  action: 'register-device';
  expiresAt: number;
}
export interface RemoteDeviceRegistration {
  challengeId: string;
  publicKey: string;
  signature: string;
  alias: string;
  platform: RemotePlatform;
}
export const getRemoteDeviceChallenge = (signal?: AbortSignal) =>
  request<{ challenge: RemoteDeviceChallenge }>('/api/remote-control/device-challenges', {
    method: 'POST',
    body: {},
    signal,
  });
export const registerRemoteDevice = (proof: RemoteDeviceRegistration, signal?: AbortSignal) =>
  request<{ device: RemoteDevice }>('/api/remote-control/devices', {
    method: 'POST',
    body: proof,
    signal,
  });
export const getRemoteControlRelease = () =>
  http.get<RemoteControlRelease>('/api/remote-control/capabilities');
export const getRemoteSessions = () =>
  http.get<{ sessions: RemoteSessionRecord[] }>('/api/remote-control/sessions');

export const getRemoteSigningKeys = () =>
  http.get<{ keys: import('@/services/remoteControlProof').RemoteSigningKey[] }>(
    '/api/remote-control/signing-keys',
  );
export const getRemoteSessionIce = (sessionId: string) =>
  http.get<import('@/services/remoteControlIce').RemoteIceConfiguration>(
    `/api/remote-control/sessions/${encodeURIComponent(sessionId)}/ice`,
  );

export interface RemoteIdentityChallenge extends Omit<RemoteDeviceChallenge, 'action'> {
  action: 'identify-device';
}
export type RemoteIdentityProof = Omit<RemoteDeviceRegistration, 'alias'>;
