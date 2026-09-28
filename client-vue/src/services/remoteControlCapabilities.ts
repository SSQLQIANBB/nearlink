import { invoke, isTauri } from '@tauri-apps/api/core';
import type { RemoteControlRelease, RemotePlatform } from '@/api/remoteControl';

export type RemotePermission = 'granted' | 'denied' | 'unknown' | 'unsupported';
export interface NativeRemoteCapabilities {
  runtime: 'tauri';
  platform: string;
  arch: string;
  osVersion: string;
  protocolVersion: number;
  engineReady: boolean;
  canCapture: boolean;
  canInjectInput: boolean;
  deviceRegistrationReady?: boolean;
  deviceIdentificationReady?: boolean;
  deviceIdentityResetReady?: boolean;
  consentPromptReady?: boolean;
  permissions: { screenCapture: RemotePermission; inputControl: RemotePermission };
}
export interface ControllerFeatures {
  secureContext: boolean;
  canDecodeVideo: boolean;
  canUseDataChannel: boolean;
  canSendInput: boolean;
  canVerifySignatures: boolean;
  supportedDesktopBrowser: boolean;
}
export type RemoteCapabilityReason = 'RELEASE_UNAVAILABLE' | 'NOT_RELEASED' | 'PLATFORM_UNSUPPORTED' | 'PROTOCOL_MISMATCH' | 'CONTROLLER_UNSUPPORTED' | 'READY';
export interface RemoteCapabilities {
  runtime: 'web' | 'tauri';
  native: NativeRemoteCapabilities | null;
  showControllerEntry: boolean;
  showHostEntry: boolean;
  canControl: boolean;
  canHostView: boolean;
  canHostControl: boolean;
  reason: RemoteCapabilityReason;
}
export const remoteCapabilityMessages: Record<RemoteCapabilityReason, string> = {
  RELEASE_UNAVAILABLE: '暂时无法确认远程控制发布状态，请稍后重试。',
  NOT_RELEASED: '此版本暂未开放远程控制，可继续使用屏幕共享。',
  PLATFORM_UNSUPPORTED: '当前桌面系统暂不支持远程控制。',
  PROTOCOL_MISMATCH: '当前客户端的远程控制协议不兼容，请升级客户端。',
  CONTROLLER_UNSUPPORTED: '当前环境不支持此版本的远程协助，请升级客户端或浏览器。',
  READY: '此设备可作为主控端。被控电脑仍须开启临时协助，并逐次确认授权。',
};

// The native capture permission only affects hosting, never the controller role.
export function deriveRemoteCapabilities(
  runtime: 'web' | 'tauri',
  release: RemoteControlRelease | null,
  native: NativeRemoteCapabilities | null,
  features: ControllerFeatures,
): RemoteCapabilities {
  const result: RemoteCapabilities = { runtime, native, showControllerEntry: false, showHostEntry: false, canControl: false, canHostView: false, canHostControl: false, reason: 'RELEASE_UNAVAILABLE' };
  if (!release || !Array.isArray(release.releasedPlatforms)) return result;
  if (release.protocolVersion !== 1 || (runtime === 'tauri' && native && native.protocolVersion !== 1)) return { ...result, reason: 'PROTOCOL_MISMATCH' };
  const desktopPlatformReleased = !!native && release.releasedPlatforms.includes(native.platform as RemotePlatform);
  const controllerReleased = runtime === 'tauri'
    ? release.desktopControllerEnabled === true && desktopPlatformReleased
    : release.webControllerReleaseEnabled === true && features.supportedDesktopBrowser;
  const hostReleased = runtime === 'tauri' && desktopPlatformReleased && release.desktopHostEnabled === true;
  const controllerSupported = features.secureContext && features.canDecodeVideo && features.canUseDataChannel && features.canSendInput && features.canVerifySignatures;
  result.showControllerEntry = controllerReleased;
  result.canControl = controllerReleased && controllerSupported;
  result.canHostView = hostReleased && native?.engineReady === true && native.canCapture === true && native.permissions?.screenCapture === 'granted';
  result.canHostControl = result.canHostView && native?.canInjectInput === true && native.permissions?.inputControl === 'granted';
  // Keep the permission/setup entry discoverable once a real host engine is released.
  result.showHostEntry = hostReleased && native?.engineReady === true;
  result.reason = result.canControl ? 'READY'
    : controllerReleased ? 'CONTROLLER_UNSUPPORTED'
    : runtime === 'tauri' && release.desktopControllerEnabled === true && !desktopPlatformReleased ? 'PLATFORM_UNSUPPORTED'
    : 'NOT_RELEASED';
  return result;
}

export function detectControllerFeatures(): ControllerFeatures {
  let canUseDataChannel = false;
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      const peer = new RTCPeerConnection({ iceServers: [] });
      try {
        const channel = peer.createDataChannel('rc-capability-check', { ordered: true });
        canUseDataChannel = channel.ordered && channel.maxRetransmits === null && channel.maxPacketLifeTime === null;
        channel.close();
      } finally { peer.close(); }
    }
  } catch { /* Unknown capabilities remain disabled. */ }
  const video = document.createElement('video');
  const canDecodeVideo = !!(video.canPlayType('video/webm; codecs="vp8"') || video.canPlayType('video/mp4; codecs="avc1.42E01E"'));
  return {
    secureContext: window.isSecureContext === true,
    canDecodeVideo,
    canUseDataChannel,
    canSendInput: typeof PointerEvent !== 'undefined' && typeof KeyboardEvent !== 'undefined',
    canVerifySignatures: false,
    // This only narrows the release audience. Real WebRTC capability is probed above.
    supportedDesktopBrowser: /(?:Chrome|Edg)\/\d+/.test(navigator.userAgent) && !/Mobile|Android|iPhone|iPad/.test(navigator.userAgent),
  };
}

export async function probeRemoteCapabilities(release: RemoteControlRelease | null): Promise<RemoteCapabilities> {
  const runtime = isTauri() ? 'tauri' : 'web';
  let native: NativeRemoteCapabilities | null = null;
  if (runtime === 'tauri') {
    try { native = await invoke<NativeRemoteCapabilities>('remote_control_capabilities'); } catch { /* A desktop shell without the native command cannot be considered supported. */ }
  }
  const features = detectControllerFeatures();
  try {
    const publicKey = Uint8Array.from(atob('11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='), char => char.charCodeAt(0));
    await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    features.canVerifySignatures = typeof RTCDtlsTransport !== 'undefined' && typeof RTCDtlsTransport.prototype.getRemoteCertificates === 'function';
  } catch { /* Unsupported signature/certificate APIs must not enable the controller. */ }
  return deriveRemoteCapabilities(runtime, release, native, features);
}
