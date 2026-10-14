/** 按实际 WebView 能力选择格式，兼容 macOS 的 MP4 录制。 */
export function selectVideoMimeType(preferred = 'video/webm;codecs=vp9') {
  if (typeof MediaRecorder === 'undefined') return '';
  return (
    [preferred, 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    ) || ''
  );
}

export function getVideoFileExtension(mimeType: string) {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}
