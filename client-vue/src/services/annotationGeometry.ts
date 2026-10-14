export function containedVideoRect(
  container: { width: number; height: number },
  video: { width: number; height: number },
) {
  if (!video.width || !video.height) return container;
  const scale = Math.min(container.width / video.width, container.height / video.height);
  return { width: video.width * scale, height: video.height * scale };
}
