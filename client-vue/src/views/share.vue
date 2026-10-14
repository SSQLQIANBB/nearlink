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
        type="primary"
        :disabled="!isSharing || isRecording"
        @click="startRecord"
      >
        开始录制
      </n-button>
      <n-button
        type="primary"
        v-if="isRecording"
        @click="stopRecord"
      >
        结束录制
      </n-button>
    </div>

    <div class="video-wrapper">
      <!-- 主屏幕 -->
      <video
        ref="screenVideoRef"
        v-show="isSharing"
        autoplay
        playsinline
        width="100%"
      />

      <!-- 摄像头画面 -->
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
          type="primary"
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

/** 启动屏幕共享 */
async function startShare() {
  try {
    const constraints: DisplayMediaStreamOptions = {
      video: {
        displaySurface: 'browser', // 'monitor' | 'window' | 'browser'
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: true, // 打开音频录制
    };

    screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: 320, height: 240 },
    });

    if (screenVideoRef.value) screenVideoRef.value.srcObject = screenStream;
    if (cameraVideoRef.value) cameraVideoRef.value.srcObject = cameraStream;

    isSharing.value = true;

    // 自动检测用户在浏览器中停止共享
    screenStream.getVideoTracks()[0]?.addEventListener('ended', stopShare);
  } catch (err) {
    console.error('获取屏幕失败:', err);
  }
}

/** 停止共享 */
function stopShare() {
  if (isRecording.value) stopRecord();

  screenStream?.getTracks().forEach((track) => track.stop());
  cameraStream?.getTracks().forEach((track) => track.stop());

  screenStream = null;
  cameraStream = null;

  if (screenVideoRef.value) screenVideoRef.value.srcObject = null;
  if (cameraVideoRef.value) cameraVideoRef.value.srcObject = null;

  isSharing.value = false;
}

/** 截取当前画面 */
function captureScreen() {
  if (!screenVideoRef.value || !cameraVideoRef.value || !canvasRef.value) return;

  const video = screenVideoRef.value;
  const camera = cameraVideoRef.value;
  const canvas = canvasRef.value;
  const context = canvas.getContext('2d');
  if (!context) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const cameraWidth = 320,
    cameraHeight = 240;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  context.drawImage(
    camera,
    canvas.width - cameraWidth - 10,
    canvas.height - cameraHeight - 10,
    cameraWidth,
    cameraHeight,
  );
  imgSrc.value = canvas.toDataURL('image/png');
}

/** 开始录制(合并流) */
function startRecord() {
  if (!screenStream || !cameraStream) return;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = 1920;
  canvas.height = 1080;

  const screenVideoEle = document.createElement('video');
  screenVideoEle.srcObject = screenStream;
  screenVideoEle.play();

  const cameraVideoEle = document.createElement('video');
  cameraVideoEle.srcObject = cameraStream;
  cameraVideoEle.play();

  // 使用canvas合成画面
  const draw = () => {
    ctx?.drawImage(screenVideoEle, 0, 0, canvas.width, canvas.height);
    const cameraWidth = 320;
    const cameraHeight = 240;
    ctx?.drawImage(
      cameraVideoEle,
      canvas.width - cameraWidth - 20,
      canvas.height - cameraHeight - 20,
      cameraWidth,
      cameraHeight,
    );
    requestAnimationFrame(draw);
  };

  draw();

  const videoOut = canvas.captureStream(30);
  const audioTracks = [...cameraStream.getAudioTracks(), ...screenStream.getAudioTracks()];

  mixedStream = new MediaStream([...videoOut.getVideoTracks(), ...audioTracks]);

  recordedChunks = [];
  recorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm; codecs=vp9' });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    recordedUrl.value = URL.createObjectURL(blob);
  };

  recorder.start();
  isRecording.value = true;
  console.log('🎥 开始录制');
}

/** 停止录制 */
function stopRecord() {
  if (!recorder) return;
  recorder.stop();
  isRecording.value = false;
  console.log('🛑 录制结束');
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

/** 组件卸载时清理资源 */
onBeforeUnmount(() => {
  stopShare();
});
</script>

<style scoped>
.screen-share {
  padding: 12px;
  width: 100%;
  max-width: 800px;
  min-height: 100%;
  margin: 0 auto;
  background: #eee;
}
.toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  min-height: 56px;
  background: #fff;
  flex-wrap: wrap;
  align-items: center;
  padding: 12px;
  border-radius: 6px;
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

.video-wrapper {
  position: relative;
  width: 100%;
  overflow: hidden;
}

.camera-preview {
  position: absolute;
  bottom: 10px;
  right: 10px;
  width: 160px;
  height: 120px;
  border-radius: 8px;
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.3);
  z-index: 10;
  background: #000;
}

@media (max-width: 480px) {
  .screen-share {
    padding: 8px;
  }

  .camera-preview {
    width: 112px;
    height: 84px;
  }
}
</style>
