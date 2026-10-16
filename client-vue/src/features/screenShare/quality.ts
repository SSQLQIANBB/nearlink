export const qualityPresets = {
  low: { label: '流畅 720p@15fps', width: 1280, height: 720, frameRate: 15, bitrate: 2_000_000 },
  medium: {
    label: '标清 1080p@24fps',
    width: 1920,
    height: 1080,
    frameRate: 24,
    bitrate: 4_000_000,
  },
  high: { label: '高清 1080p@30fps', width: 1920, height: 1080, frameRate: 30, bitrate: 8_000_000 },
  ultra: { label: '超清 2K@30fps', width: 2560, height: 1440, frameRate: 30, bitrate: 12_000_000 },
};
export type ShareQuality = keyof typeof qualityPresets;
export function isShareQuality(value: string): value is ShareQuality {
  return Object.prototype.hasOwnProperty.call(qualityPresets, value);
}
export async function configureScreenSender(sender: RTCRtpSender, quality: ShareQuality) {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = qualityPresets[quality].bitrate;
    encoding.maxFramerate = qualityPresets[quality].frameRate;
    encoding.scaleResolutionDownBy = 1;
  }
  parameters.degradationPreference =
    sender.track?.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  await sender.setParameters(parameters);
}
