<template>
  <DialogSurface
    :standalone="standalone"
    :show="true"
    preset="card"
    title="裁剪头像"
    class="avatar-crop-modal"
    style="width: min(420px, calc(100vw - 24px))"
    :mask-closable="false"
    :close-on-esc="!uploading"
    :closable="!uploading"
    @close="emit('cancel')"
    @update:show="!$event && emit('cancel')"
  >
    <p class="crop-hint">拖动调整位置，双指或滚轮缩放</p>
    <div class="crop-stage">
      <canvas
        ref="canvas"
        width="512"
        height="512"
        class="crop-preview"
        aria-label="头像裁剪预览"
        v-on="handlers"
      />
      <div
        class="crop-mask"
        aria-hidden="true"
      ></div>
    </div>
    <p
      v-if="loadError"
      role="alert"
    >
      图片无法读取，请重新选择 JPG 或 PNG 图片
    </p>
    <template #footer>
      <div class="crop-actions">
        <n-button
          :disabled="uploading"
          @click="emit('cancel')"
        >
          取消
        </n-button>
        <n-button
          type="primary"
          :disabled="!ready"
          :loading="uploading"
          @click="upload"
        >
          确认裁剪并上传
        </n-button>
      </div>
    </template>
  </DialogSurface>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import DialogSurface from './DialogSurface.vue';
import { uploadFile } from '@/api/common';
import { useImageGestures } from '@/hooks/useImageGestures';

const props = defineProps<{ file: File; standalone?: boolean; uploadFile?: typeof uploadFile }>();
const emit = defineEmits<{ cancel: []; uploaded: [url: string] }>();
const message = useMessage();
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const loadError = ref(false);
const uploading = ref(false);
const photo = new Image();
const sourceUrl = URL.createObjectURL(props.file);
let disposed = false;
const { transform, handlers } = useImageGestures(canvas, {
  minScale: 0.25,
  maxScale: 3,
  enabled: () => ready.value && !uploading.value,
  constrain: (value) => {
    const side = canvas.value!.getBoundingClientRect().width;
    const fit = side / Math.min(photo.naturalWidth, photo.naturalHeight);
    // 图片大于裁剪框时限制露白，小于裁剪框时允许在框内调整位置。
    const maxX = Math.abs(photo.naturalWidth * fit * value.scale - side) / 2;
    const maxY = Math.abs(photo.naturalHeight * fit * value.scale - side) / 2;
    return {
      scale: value.scale,
      x: Math.max(-maxX, Math.min(maxX, value.x)),
      y: Math.max(-maxY, Math.min(maxY, value.y)),
    };
  },
});

function draw() {
  if (!ready.value || !canvas.value) return;
  const side = Math.min(photo.naturalWidth, photo.naturalHeight) / transform.value.scale;
  const ratio = side / canvas.value.getBoundingClientRect().width;
  const x = (photo.naturalWidth - side) / 2 - transform.value.x * ratio;
  const y = (photo.naturalHeight - side) / 2 - transform.value.y * ratio;
  const context = canvas.value.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 512, 512);
  context.drawImage(photo, x, y, side, side, 0, 0, 512, 512);
}

async function upload() {
  if (uploading.value) return;
  uploading.value = true;
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.value!.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('图片裁剪失败'))),
        'image/jpeg',
        0.9,
      );
    });
    if (disposed) return;
    const form = new FormData();
    form.append('file', new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    form.append('purpose', 'avatar');
    const { file } = await (props.uploadFile || uploadFile)(form);
    if (!disposed) emit('uploaded', file.fileUrl);
  } catch (error: any) {
    if (!disposed) message.error('上传失败: ' + error.message);
  } finally {
    uploading.value = false;
  }
}

watch(transform, draw, { flush: 'sync' });
onMounted(() => {
  photo.onload = () => {
    ready.value = true;
    draw();
  };
  photo.onerror = () => {
    loadError.value = true;
  };
  photo.src = sourceUrl;
});
onBeforeUnmount(() => {
  disposed = true;
  photo.onload = null;
  photo.onerror = null;
  URL.revokeObjectURL(sourceUrl);
});
</script>

<style scoped>
.crop-hint {
  margin-bottom: 16px;
  color: #64748b;
}
.crop-stage {
  position: relative;
  width: 280px;
  max-width: 100%;
  margin: auto;
  overflow: hidden;
}
.crop-preview {
  display: block;
  width: 100%;
  height: auto;
  background: #f1f5f9;
  touch-action: none;
  cursor: grab;
}
.crop-preview:active {
  cursor: grabbing;
}
.crop-mask {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.8);
  box-shadow: 0 0 0 200px rgba(0, 0, 0, 0.55);
  pointer-events: none;
}
.crop-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
