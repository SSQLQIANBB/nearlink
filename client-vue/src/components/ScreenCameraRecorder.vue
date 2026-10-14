<template>
  <div style="padding: 12px">
    <div style="display: flex; gap: 8px; margin-bottom: 12px">
      <n-button
        type="primary"
        @click="startRecording"
        :disabled="isRecording"
      >
        开始录制
      </n-button>
      <n-button
        type="error"
        @click="stopRecording"
        :disabled="!isRecording"
      >
        停止录制
      </n-button>
    </div>

    <video
      ref="previewRef"
      autoplay
      playsinline
      width="100%"
    />
    <video
      v-if="recordedUrl"
      :src="recordedUrl"
      controls
      width="100%"
      style="margin-top: 12px"
    />
  </div>
</template>

<script lang="ts" setup>
import { ref, onUnmounted } from 'vue';

const previewRef = ref<HTMLVideoElement>();
const recordedUrl = ref<string>();
const isRecording = ref(false);

let screenStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let mixedStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let worker: Worker | null = null;

async function startRecording() {
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240 },
    audio: true,
  });

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;

  const offscreen = canvas.transferControlToOffscreen();

  worker = new Worker(new URL('../workers/recorderWorker.ts', import.meta.url), { type: 'module' });
  worker.postMessage(
    {
      type: 'init',
      data: {
        canvas: offscreen,
        screenStream,
        cameraStream,
        width: 1280,
        height: 720,
      },
    },
    [offscreen],
  );

  worker.postMessage({ type: 'start' });

  // 捕获最终视频流
  mixedStream = canvas.captureStream(30);
  previewRef.value!.srcObject = mixedStream;

  recorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm;codecs=vp8' });
  chunks = [];

  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    recordedUrl.value = URL.createObjectURL(blob);
    chunks = [];
  };

  recorder.start();
  isRecording.value = true;
}

function stopRecording() {
  if (worker) worker.postMessage({ type: 'stop' });
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  screenStream?.getTracks().forEach((t) => t.stop());
  cameraStream?.getTracks().forEach((t) => t.stop());
  isRecording.value = false;
}

onUnmounted(() => {
  if (worker) worker.terminate();
});
</script>
