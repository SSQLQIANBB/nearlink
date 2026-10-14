/** Account admission is handled by authenticated REST/Socket sessions. */
export function getRemoteControlCapabilities() {
  return {
    protocolVersion: 1 as const,
    desktopControllerEnabled: true,
    desktopHostEnabled: true,
    webControllerReleaseEnabled: true,
    releasedPlatforms: ['macos', 'windows'],
    engineRequired: true,
    reason: 'READY',
  };
}
