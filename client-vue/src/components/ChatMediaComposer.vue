<template>
  <div
    class="chat-media-composer"
    :class="{ compact }"
  >
    <input
      ref="imageInput"
      class="sr-only"
      type="file"
      accept="image/*"
      @change="handleImageSelected"
    />
    <div class="composer-toolbar">
      <slot name="toolbar" />
      <n-button
        aria-label="发送图片"
        title="发送图片"
        :loading="uploadingType === 'image'"
        :disabled="disabled || uploading || recording"
        @click="imageInput?.click()"
      >
        <template #icon>
          <i
            class="iconfont composer-image-icon icon-image1"
            aria-hidden="true"
          ></i>
        </template>
        <span>发送图片</span>
      </n-button>
    </div>
    <div class="composer-input-row">
      <button
        v-if="compact"
        type="button"
        class="voice-mode-toggle"
        :class="{ 'voice-mode-toggle--active': voiceMode }"
        :aria-label="voiceMode ? '切换文字输入' : '切换语音输入'"
        :title="voiceMode ? '切换文字输入' : '切换语音输入'"
        :disabled="disabled || uploading || recording"
        @click="toggleVoiceMode"
      >
        <i
          class="iconfont"
          :class="voiceMode ? 'icon-keyboard' : 'icon-yuyin'"
          aria-hidden="true"
        ></i>
      </button>
      <div
        v-if="compact"
        v-show="!voiceMode"
        class="text-mode"
      >
        <slot />
      </div>
      <button
        v-if="!compact || voiceMode"
        type="button"
        class="hold-to-talk"
        aria-label="按住说话，松开发送"
        title="按住说话，松开发送"
        :class="{ 'hold-to-talk--active': recording, 'hold-to-talk--cancel': cancelIntent }"
        :disabled="disabled || uploading"
        @pointerdown.prevent="startRecording"
        @pointerup.prevent="finishRecording"
        @pointermove="updateCancelIntent"
        @lostpointercapture="isPressing && cancelRecording()"
        @keydown.esc.prevent="cancelRecording"
        @blur="isPressing && cancelRecording()"
        @pointercancel="cancelRecording"
        @keydown.space.prevent="startRecording"
        @keyup.space.prevent="finishRecording"
        @contextmenu.prevent
      >
        <AudioWaveform
          v-if="recording && recordingStream"
          :stream="recordingStream"
        >
          <span>{{ cancelIntent ? '松开取消' : '松开 发送' }}</span>
          <small>{{ elapsedSeconds || 1 }}s</small>
        </AudioWaveform>
        <span v-else>{{ uploadingType === 'voice' ? '发送中…' : '按住 说话' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import AudioWaveform from './AudioWaveform.vue';
import { NButton, useMessage } from 'naive-ui';
import { uploadFile } from '@/api/common';
import type { ChatMediaPayload } from '@/api/message';
import { getAudioFileExtension, selectAudioMimeType } from '@/services/chatMedia';

const props = defineProps<{ disabled?: boolean; groupId?: number; compact?: boolean }>();
const emit = defineEmits<{
  send: [payload: { type: 'image' | 'voice'; media: ChatMediaPayload }];
}>();

const message = useMessage();
const imageInput = ref<HTMLInputElement | null>(null);
const uploadingType = ref<'image' | 'voice' | null>(null);
const uploading = computed(() => uploadingType.value !== null);
const recording = ref(false);
const voiceMode = ref(false);
let recordingAttempt = 0;
const cancelIntent = ref(false);
let pressStartY = 0;
const elapsedSeconds = ref(0);
let recorder: MediaRecorder | null = null;
const recordingStream = shallowRef<MediaStream | null>(null);
let recordingStartedAt = 0;
let recordingTimer: number | null = null;
let chunks: Blob[] = [];
let discardRecording = false;
let isPressing = false;

async function uploadMedia(file: File, type: 'image' | 'voice', durationSeconds?: number) {
  uploadingType.value = type;
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', 'chat');
    if (props.groupId) form.append('groupId', String(props.groupId));
    const { file: uploaded } = await uploadFile(form);
    emit('send', {
      type,
      media: {
        url: uploaded.fileUrl,
        fileId: uploaded.id,
        mimeType: uploaded.mimeType,
        fileName: uploaded.originalName,
        fileSize: uploaded.fileSize,
        ...(durationSeconds ? { durationSeconds } : {}),
      },
    });
  } catch (error: any) {
    message.error(`上传失败: ${error.message}`);
  } finally {
    uploadingType.value = null;
  }
}

async function handleImageSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    message.warning('请选择图片文件');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    message.warning('图片不能超过 10MB');
    return;
  }
  await uploadMedia(file, 'image');
}

function toggleVoiceMode() {
  cancelRecording();
  voiceMode.value = !voiceMode.value;
}

async function startRecording(event?: PointerEvent | KeyboardEvent) {
  if (isPressing || recording.value || props.disabled || uploading.value) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    message.error('当前浏览器不支持语音录制');
    return;
  }

  const attempt = ++recordingAttempt;
  isPressing = true;
  if (event && 'pointerId' in event) {
    pressStartY = event.clientY;
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!isPressing || attempt !== recordingAttempt) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    recordingStream.value = stream;
    const mimeType = selectAudioMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunks = [];
    discardRecording = false;
    recordingStartedAt = Date.now();
    elapsedSeconds.value = 0;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = handleRecordingStopped;
    recorder.start();
    recording.value = true;
    recordingTimer = window.setInterval(() => {
      elapsedSeconds.value = Math.min(
        60,
        Math.max(1, Math.floor((Date.now() - recordingStartedAt) / 1000)),
      );
      if (elapsedSeconds.value >= 60) finishRecording();
    }, 250);
  } catch (error: any) {
    if (attempt !== recordingAttempt) return;
    releaseRecordingResources();
    message.error(`无法使用麦克风: ${error.message}`);
  }
}

function updateCancelIntent(event: PointerEvent) {
  if (isPressing) cancelIntent.value = pressStartY - event.clientY >= 48;
}

function finishRecording() {
  if (cancelIntent.value) {
    cancelRecording();
    return;
  }
  isPressing = false;
  if (recorder?.state === 'recording') recorder.stop();
}

function cancelRecording() {
  if (!isPressing && !recording.value) return;
  isPressing = false;
  discardRecording = true;
  if (recorder?.state === 'recording') recorder.stop();
  else if (!recorder) releaseRecordingResources();
}

function handleRecordingStopped() {
  const durationSeconds = Math.min(
    60,
    Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000)),
  );
  const mimeType = recorder?.mimeType || 'audio/webm';
  const audio = new Blob(chunks, { type: mimeType });
  const shouldUpload = !discardRecording && audio.size > 0;
  releaseRecordingResources();
  if (!shouldUpload) return;
  const file = new File([audio], `voice-${Date.now()}.${getAudioFileExtension(mimeType)}`, {
    type: mimeType,
  });
  void uploadMedia(file, 'voice', durationSeconds);
}

function releaseRecordingResources() {
  recordingAttempt++;
  isPressing = false;
  if (recordingTimer !== null) window.clearInterval(recordingTimer);
  recordingTimer = null;
  recordingStream.value?.getTracks().forEach((track) => track.stop());
  recordingStream.value = null;
  recorder = null;
  chunks = [];
  recording.value = false;
  cancelIntent.value = false;
  elapsedSeconds.value = 0;
}

onBeforeUnmount(cancelRecording);
</script>

<style scoped>
.chat-media-composer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
}

.hold-to-talk {
  flex: 1;
  min-width: 0;
  min-height: 48px;
  padding: 10px 16px;
  border: 1px solid #e2e8f0;
  border-radius: 24px;
  color: #334155;
  background: #f3f4f6;
  font-size: 16px;
  font-weight: 500;
  user-select: none;
  touch-action: none;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.hold-to-talk--active {
  background: #dbeafe;
  border-color: #60a5fa;
  color: #2563eb;
  box-shadow: 0 2px 4px #2563eb12;
}

.hold-to-talk--cancel {
  background: #fee2e2;
  border-color: #f87171;
  color: #dc2626;
}

.hold-to-talk:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}

.hold-to-talk small {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.compact {
  --icon-size-composer: 24px;
  flex-wrap: nowrap;
}

.text-mode {
  flex: 1;
  min-width: 0;
}

.voice-mode-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid #e2e8f0;
  border-radius: 50%;
  background: #f8fafc;
  color: #64748b;
  cursor: pointer;
}
.voice-mode-toggle:hover:not(:disabled) {
  background: #eff6ff;
  color: #2563eb;
}
.voice-mode-toggle:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.voice-mode-toggle--active {
  color: #2563eb;
}

.voice-mode-toggle:disabled {
  cursor: not-allowed;
}

.voice-mode-toggle .iconfont {
  font-size: 24px;
  line-height: 1;
}

.composer-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  width: 100%;
}
.composer-toolbar :deep(.call-toolbar) {
  display: contents;
}
.composer-toolbar :deep(.n-button) {
  --icon-size-control: 18px;
  --n-color: #f1f5f9 !important;
  --n-color-hover: #e2e8f0 !important;
  --n-color-pressed: #cbd5e1 !important;
  --n-text-color: #475569 !important;
  --n-text-color-hover: #1e293b !important;
  --n-border: 1px solid transparent !important;
  --n-border-hover: 1px solid transparent !important;
  border-radius: 999px;
  font-size: 12px;
}
.composer-image-icon {
  width: 18px;
  height: 18px;
  font-size: 16px;
}
.composer-input-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid #e2e8f0;
}
@media (max-width: 767px) {
  .composer-toolbar {
    gap: 6px;
    padding-top: 9px;
  }
  .composer-toolbar :deep(.n-button) {
    padding-inline: 10px;
  }
  .composer-input-row {
    padding: 14px 10px;
    gap: 8px;
  }
}
</style>
