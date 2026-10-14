import type { Results, SelfieSegmentation } from '@mediapipe/selfie_segmentation';

const assets = import.meta.glob(
  '/node_modules/@mediapipe/selfie_segmentation/*.{js,wasm,tflite,binarypb,data}',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;

export async function createSegmenter() {
  const { SelfieSegmentation } = await import('@mediapipe/selfie_segmentation');
  const segmenter = new SelfieSegmentation({
    locateFile: (file) => {
      const url = assets[`/node_modules/@mediapipe/selfie_segmentation/${file}`];
      if (!url) throw new Error(`背景模型资源缺失: ${file}`);
      return url;
    },
  });
  segmenter.setOptions({ modelSelection: 1 });
  return segmenter;
}

export type BackgroundStyle = {
  effect: 'color' | 'image';
  color: string;
  image: HTMLImageElement | null;
};

export function composeBackground(
  ctx: CanvasRenderingContext2D,
  results: Results,
  width: number,
  height: number,
  style: BackgroundStyle,
) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(results.segmentationMask, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(results.image, 0, 0, width, height);
  ctx.globalCompositeOperation = 'destination-over';
  if (style.effect === 'image' && style.image) {
    ctx.drawImage(style.image, 0, 0, width, height);
  } else {
    ctx.fillStyle = style.color;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

// 处理器仅拥有合成视频轨道；麦克风和摄像头由会议页面管理。
export function stopProcessedVideo(stream: MediaStream | null) {
  stream?.getVideoTracks().forEach((track) => track.stop());
}
export type Segmenter = SelfieSegmentation;
