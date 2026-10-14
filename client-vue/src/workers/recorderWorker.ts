let screenVideo: HTMLVideoElement | null = null;
let cameraVideo: HTMLVideoElement | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let running = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === 'init') {
    const { canvas, screenStream, cameraStream } = data;
    ctx = canvas.getContext('2d');

    // 通过 OffscreenCanvas 绘制需要创建 video 元素
    screenVideo = document.createElement('video');
    cameraVideo = document.createElement('video');
    screenVideo.srcObject = screenStream;
    cameraVideo.srcObject = cameraStream;
    await Promise.all([screenVideo.play(), cameraVideo.play()]);
  }

  if (type === 'start') {
    running = true;
    draw();
  }

  if (type === 'stop') {
    running = false;
  }
};

function draw() {
  if (!ctx || !screenVideo || !cameraVideo) return;
  ctx.clearRect(0, 0, 1280, 720);
  ctx.drawImage(screenVideo, 0, 0, 1280, 720);
  ctx.drawImage(cameraVideo, 1024, 540, 256, 180);

  if (running) requestAnimationFrame(draw);
}
