<template>
  <div class="media-recorder">
    <!-- 录制控制按钮 -->
    <n-button
      v-if="!isRecording"
      @click="startRecording"
      type="error"
      :disabled="!canRecord"
      size="large"
      circle
    >
      <template #icon>
        <n-icon size="24">
          <i
            class="iconfont icon-record"
            aria-hidden="true"
          ></i>
        </n-icon>
      </template>
    </n-button>

    <n-space
      v-else
      align="center"
    >
      <!-- 录制时间 -->
      <n-tag
        type="error"
        size="large"
      >
        <template #icon>
          <n-icon>
            <i
              class="iconfont icon-record"
              aria-hidden="true"
            ></i>
          </n-icon>
        </template>
        {{ formatTime(recordingTime) }}
      </n-tag>

      <!-- 暂停/继续 -->
      <n-button
        @click="togglePause"
        type="primary"
        circle
      >
        <template #icon>
          <n-icon
            v-if="isPaused"
            size="20"
          >
            <i
              class="iconfont icon-play"
              aria-hidden="true"
            ></i>
          </n-icon>
          <n-icon
            v-else
            size="20"
          >
            <i
              class="iconfont icon-pause"
              aria-hidden="true"
            ></i>
          </n-icon>
        </template>
      </n-button>

      <!-- 停止录制 -->
      <n-button
        @click="stopRecording"
        type="error"
        circle
      >
        <template #icon>
          <n-icon size="20">
            <i
              class="iconfont icon-stop"
              aria-hidden="true"
            ></i>
          </n-icon>
        </template>
      </n-button>
    </n-space>

    <!-- 录制完成对话框 -->
    <n-modal
      v-model:show="showSaveDialog"
      preset="card"
      :mask-closable="!saving"
      :close-on-esc="!saving"
      :closable="!saving"
      title="录制完成"
      style="width: min(600px, calc(100vw - 24px))"
    >
      <n-space vertical>
        <div>
          <n-text>录制时长: {{ formatTime(recordingTime) }}</n-text>
        </div>
        <div>
          <n-text>文件大小: {{ formatFileSize(recordedBlob?.size || 0) }}</n-text>
        </div>

        <!-- 视频预览 -->
        <video
          v-if="recordedUrl"
          :src="recordedUrl"
          controls
          class="video-preview"
        ></video>

        <!-- 文件名输入 -->
        <n-input
          v-model:value="fileName"
          placeholder="请输入文件名"
        >
          <template #suffix>.{{ recordingExtension }}</template>
        </n-input>
      </n-space>

      <template #footer>
        <n-space justify="end">
          <n-button
            :disabled="saving"
            @click="discardRecording"
          >
            丢弃
          </n-button>
          <n-button
            type="primary"
            :loading="saving"
            @click="downloadRecording"
          >
            <template #icon>
              <n-icon>
                <i
                  class="iconfont icon-download"
                  aria-hidden="true"
                ></i>
              </n-icon>
            </template>
            下载
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { useMessage } from 'naive-ui';
import { saveFile } from '@/services/saveFile';
import { selectVideoMimeType, getVideoFileExtension } from '@/services/recordingFormat';

interface MediaRecorderProps {
  stream?: MediaStream | null;
  mimeType?: string;
}

const props = withDefaults(defineProps<MediaRecorderProps>(), {
  mimeType: 'video/webm;codecs=vp9',
});

const emit = defineEmits<{
  (e: 'recording-start'): void;
  (e: 'recording-stop', blob: Blob): void;
  (e: 'recording-error', error: Error): void;
}>();

const message = useMessage();
const saving = ref(false);

// 录制状态
const isRecording = ref(false);
const isPaused = ref(false);
const recordingTime = ref(0);
const recordedChunks = ref<Blob[]>([]);
const recordedBlob = ref<Blob | null>(null);
const recordedUrl = ref('');
const fileName = ref('');
const showSaveDialog = ref(false);

let mediaRecorder: MediaRecorder | null = null;
let timerInterval: number | null = null;

// 是否可以录制
const recordingMimeType = computed(() => selectVideoMimeType(props.mimeType));
const recordingExtension = computed(() =>
  getVideoFileExtension(recordedBlob.value?.type || recordingMimeType.value),
);
const canRecord = computed(() => {
  return props.stream && !!recordingMimeType.value;
});

// 开始录制
async function startRecording() {
  if (!props.stream) {
    message.error('没有可录制的媒体流');
    return;
  }

  try {
    // 创建 MediaRecorder
    const options: MediaRecorderOptions = {
      mimeType: recordingMimeType.value,
      videoBitsPerSecond: 2500000, // 2.5 Mbps
    };

    mediaRecorder = new MediaRecorder(props.stream, options);
    recordedChunks.value = [];

    // 监听数据
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.value.push(event.data);
      }
    };

    // 监听停止
    mediaRecorder.onstop = handleRecordingStop;

    // 监听错误
    mediaRecorder.onerror = (event: Event) => {
      const error = new Error('录制出错');
      console.error('MediaRecorder error:', event);
      message.error('录制出错');
      emit('recording-error', error);
    };

    // 开始录制
    mediaRecorder.start(1000); // 每秒保存一次数据
    isRecording.value = true;
    isPaused.value = false;
    recordingTime.value = 0;

    // 开始计时
    startTimer();

    // 生成默认文件名
    fileName.value = `recording_${new Date().getTime()}`;

    message.success('开始录制');
    emit('recording-start');
  } catch (error: any) {
    console.error('启动录制失败:', error);
    message.error('启动录制失败: ' + error.message);
    emit('recording-error', error);
  }
}

// 停止录制
function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return;
  }

  mediaRecorder.stop();
  stopTimer();
  isRecording.value = false;
  isPaused.value = false;
}

// 暂停/继续
function togglePause() {
  if (!mediaRecorder) return;

  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    isPaused.value = true;
    stopTimer();
    message.info('录制已暂停');
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    isPaused.value = false;
    startTimer();
    message.info('录制已继续');
  }
}

// 处理录制停止
function handleRecordingStop() {
  // 创建 Blob
  recordedBlob.value = new Blob(recordedChunks.value, {
    type: mediaRecorder?.mimeType || recordingMimeType.value,
  });

  // 创建预览 URL
  recordedUrl.value = URL.createObjectURL(recordedBlob.value);

  // 显示保存对话框
  showSaveDialog.value = true;

  message.success('录制完成');
  emit('recording-stop', recordedBlob.value);
}

// 下载录制文件
async function downloadRecording() {
  if (!recordedBlob.value || saving.value) return;
  saving.value = true;
  try {
    if (!(await saveFile(recordedBlob.value, `${fileName.value}.${recordingExtension.value}`)))
      return;
    message.success('保存成功');
    showSaveDialog.value = false;
    resetRecording();
  } catch {
    message.error('保存失败，请重试');
  } finally {
    saving.value = false;
  }
}

// 丢弃录制
function discardRecording() {
  showSaveDialog.value = false;
  resetRecording();
  message.info('已丢弃录制');
}

// 重置录制状态
function resetRecording() {
  if (recordedUrl.value) URL.revokeObjectURL(recordedUrl.value);
  recordedChunks.value = [];
  recordedBlob.value = null;
  recordedUrl.value = '';
  recordingTime.value = 0;
  fileName.value = '';
}

// 开始计时
function startTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  timerInterval = window.setInterval(() => {
    recordingTime.value++;
  }, 1000);
}

// 停止计时
function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// 格式化时间
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// 组件卸载时清理
onUnmounted(() => {
  if (isRecording.value) {
    stopRecording();
  }
  stopTimer();
  if (recordedUrl.value) {
    URL.revokeObjectURL(recordedUrl.value);
  }
});

// 暴露方法
defineExpose({
  startRecording,
  stopRecording,
  togglePause,
  isRecording,
  isPaused,
});
</script>

<style scoped>
.media-recorder {
  display: inline-flex;
  align-items: center;
}

.video-preview {
  width: 100%;
  max-height: 400px;
  border-radius: 8px;
  background: #000;
}
</style>
