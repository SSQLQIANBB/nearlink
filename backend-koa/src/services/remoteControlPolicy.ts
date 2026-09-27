/** Public release stays closed. Explicit named-account preview permits product
 * acceptance testing without exposing unvalidated platforms to every user. */
export function getRemoteControlCapabilities(userId?: number, env: NodeJS.ProcessEnv = process.env) {
  const configured = env.REMOTE_CONTROL_PREVIEW_USER_IDS || '';
  const preview = Number.isSafeInteger(userId) && userId! > 0
    && /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(configured)
    && configured.split(',').length <= 20
    && configured.split(',').some(id => Number(id) === userId);
  return {
    protocolVersion: 1 as const,
    desktopControllerEnabled: preview,
    desktopHostEnabled: preview,
    webControllerReleaseEnabled: preview,
    releasedPlatforms: preview ? ['macos'] : [] as string[],
    engineRequired: true,
    reason: preview ? 'ACCOUNT_PREVIEW' : 'NATIVE_VALIDATION_PENDING',
  };
}
