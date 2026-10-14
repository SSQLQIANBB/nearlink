let offscreen: OffscreenCanvas | null = null;
let screenStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let screenVideo: HTMLVideoElement | null = null;
let cameraVideo: HTMLVideoElement | null = null;
let width = 1920;
let height = 1080;
let animId: number | null = null;

self.onmessage = async (e) => {
  const { type, data } = e.data;

  if (type === 'init') {
    offscreen = data.canvas;
    ctx = offscreen!.getContext('2d');
    screenStream = data.screenStream;
    cameraStream = data.cameraStream;
    width = data.width;
    height = data.height;

    screenVideo = await createVideo(screenStream!);
    cameraVideo = await createVideo(cameraStream!);
  }

  if (type === 'start') {
    drawFrame();
  }

  if (type === 'stop') {
    if (animId) cancelAnimationFrame(animId);
    screenVideo?.pause();
    cameraVideo?.pause();
  }
};

async function createVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  return video;
}

function drawFrame() {
  if (!ctx || !screenVideo) return;

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(screenVideo, 0, 0, width, height);

  if (cameraVideo) {
    const cw = 320,
      ch = 240;
    ctx.drawImage(cameraVideo, width - cw - 16, height - ch - 16, cw, ch);
  }

  animId = requestAnimationFrame(drawFrame);
}
