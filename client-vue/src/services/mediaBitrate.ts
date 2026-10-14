/** Keep video from saturating small links while leaving audio encoding untouched. */
export async function limitVideoBitrate(sender: RTCRtpSender, maxBitrate: number) {
  if (sender.track?.kind !== 'video' || !sender.getParameters || !sender.setParameters) return;
  try {
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings.forEach((encoding) => {
      encoding.maxBitrate = maxBitrate;
    });
    await sender.setParameters(parameters);
  } catch (error) {
    // Unsupported browser/codec: keep the original video path working.
    console.warn('无法设置视频发送码率:', error);
  }
}
