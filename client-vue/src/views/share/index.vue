<template>
  <div class="screen-share">
    <div class="toolbar">
      <n-button
        type="primary"
        :disabled="isSharing"
        @click="startShare"
      >
        共享屏幕
      </n-button>
      <n-button
        type="error"
        v-if="isSharing"
        @click="stopShare"
      >
        结束共享
      </n-button>
      <n-button
        @click="captureScreen"
        :disabled="!isSharing"
      >
        截图
      </n-button>

      <n-button
        type="success"
        :disabled="!isSharing || isRecording"
        @click="startRecord"
      >
        开始录制
      </n-button>
      <n-button
        type="warning"
        v-if="isRecording"
        @click="stopRecord"
      >
        结束录制
      </n-button>
    </div>

    <div class="video-wrapper">
      <video
        ref="screenVideoRef"
        v-show="isSharing"
        autoplay
        playsinline
        width="100%"
      />
      <video
        ref="cameraVideoRef"
        autoplay
        muted
        playsinline
        class="camera-preview"
        v-show="isSharing"
      />
    </div>

    <canvas
      ref="canvasRef"
      style="display: none"
    ></canvas>

    <img
      v-if="imgSrc"
      :src="imgSrc"
      alt="截图结果"
      class="screenshot"
    />

    <div
      v-if="recordedUrl"
      class="recorded"
    >
      <h4>录制结果：</h4>
      <video
        :src="recordedUrl"
        controls
        width="100%"
      />
      <div style="margin-top: 8px">
        <n-button
          type="info"
          :loading="saving"
          @click="downloadRecord"
        >
          下载视频
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import { useMessage } from 'naive-ui';
import { saveFile } from '@/services/saveFile';

const message = useMessage();
const saving = ref(false);

const screenVideoRef = ref<HTMLVideoElement | null>(null);
const cameraVideoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const imgSrc = ref<string | null>(null);
const recordedUrl = ref<string | null>(null);

const isSharing = ref(false);
const isRecording = ref(false);

let screenStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let mixedStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let recordedChunks: BlobPart[] = [];
let worker: Worker | null = null;

/** 启动屏幕共享 */
async function startShare() {
  try {
    const constraints: DisplayMediaStreamOptions = {
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, displaySurface: 'browser' },
      audio: true,
    };

    screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: 320, height: 240 },
    });

    if (screenVideoRef.value) screenVideoRef.value.srcObject = screenStream;
    if (cameraVideoRef.value) cameraVideoRef.value.srcObject = cameraStream;

    isSharing.value = true;
    screenStream.getVideoTracks()[0]?.addEventListener('ended', stopShare);
  } catch (err) {
    console.error('获取屏幕失败:', err);
  }
}

/** 停止共享 */
function stopShare() {
  if (isRecording.value) stopRecord();

  screenStream?.getTracks().forEach((t) => t.stop());
  cameraStream?.getTracks().forEach((t) => t.stop());

  if (screenVideoRef.value) screenVideoRef.value.srcObject = null;
  if (cameraVideoRef.value) cameraVideoRef.value.srcObject = null;

  isSharing.value = false;
  screenStream = null;
  cameraStream = null;
}

/** 截图 */
function captureScreen() {
  if (!screenVideoRef.value || !cameraVideoRef.value || !canvasRef.value) return;
  const video = screenVideoRef.value;
  const camera = cameraVideoRef.value;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(camera, canvas.width - 320 - 20, canvas.height - 240 - 20, 320, 240);
  imgSrc.value = canvas.toDataURL('image/png');
}

/** 开始录制（OffscreenCanvas + Worker） */
async function startRecord() {
  if (!screenStream || !cameraStream) return;

  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const offscreen = canvas.transferControlToOffscreen();

  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage(
    {
      type: 'init',
      data: {
        canvas: offscreen,
        screenStream,
        cameraStream,
        width: 1920,
        height: 1080,
      },
    },
    [offscreen],
  );

  const videoOut = canvas.captureStream(60);
  const audioTracks = [...screenStream.getAudioTracks(), ...cameraStream.getAudioTracks()];

  mixedStream = new MediaStream([...videoOut.getVideoTracks(), ...audioTracks]);
  recordedChunks = [];

  recorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm; codecs=vp9' });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    recordedUrl.value = URL.createObjectURL(blob);
    worker?.postMessage({ type: 'stop' });
  };

  recorder.start();
  worker.postMessage({ type: 'start' });
  isRecording.value = true;
}

/** 停止录制 */
function stopRecord() {
  if (!recorder) return;
  recorder.stop();
  isRecording.value = false;
}

/** 下载录制结果 */
async function downloadRecord() {
  if (!recordedUrl.value || saving.value) return;
  saving.value = true;
  try {
    await saveFile(new Blob(recordedChunks, { type: 'video/webm' }), `record-${Date.now()}.webm`);
  } catch {
    message.error('保存失败，请重试');
  } finally {
    saving.value = false;
  }
}

onBeforeUnmount(() => stopShare());
</script>

<style scoped>
.screen-share {
  padding: 12px;
  max-width: 800px;
  margin: 0 auto;
  background: #eee;
}
.toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  background: #fff;
  flex-wrap: wrap;
  align-items: center;
  padding: 12px;
  border-radius: 6px;
}
.video-wrapper {
  position: relative;
}
.camera-preview {
  position: absolute;
  bottom: 10px;
  right: 10px;
  width: 160px;
  height: 120px;
  border-radius: 8px;
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.3);
  background: #000;
}
.screenshot {
  margin-top: 12px;
  max-width: 100%;
  border: 1px solid #ddd;
  border-radius: 4px;
}
.recorded {
  margin-top: 16px;
  border-top: 1px solid #eee;
  padding-top: 8px;
}
</style>
