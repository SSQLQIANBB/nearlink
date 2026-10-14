<template>
  <n-modal
    :show="true"
    @update:show="!$event && emit('close')"
  >
    <div
      class="image-preview"
      role="dialog"
      aria-label="图片预览"
      aria-modal="true"
    >
      <div
        ref="viewport"
        class="image-preview__viewport"
        v-on="handlers"
        @dblclick="reset"
      >
        <img
          ref="image"
          :src="src"
          :alt="alt"
          :style="imageStyle"
          draggable="false"
          @load="loaded"
          @error="loadError = true"
        />
        <span
          v-if="loadError"
          role="alert"
        >
          图片加载失败
        </span>
        <span
          v-else-if="!ready"
          role="status"
        >
          图片加载中…
        </span>
      </div>
      <div class="image-preview__toolbar">
        <span class="image-preview__hint">双指或滚轮缩放，拖动查看</span>
        <button
          type="button"
          aria-label="向左旋转"
          @click="rotate(-90)"
        >
          <i
            class="iconfont icon-xiangzuoxuanzhuan"
            aria-hidden="true"
          ></i>
        </button>
        <button
          type="button"
          aria-label="向右旋转"
          @click="rotate(90)"
        >
          <i
            class="iconfont icon-xiangyouxuanzhuan"
            aria-hidden="true"
          ></i>
        </button>
        <button
          type="button"
          @click="reset"
          aria-label="重置图片"
        >
          <i
            class="iconfont icon-zhongzhi"
            aria-hidden="true"
          ></i>
        </button>
        <a
          :href="src"
          :download="alt"
          target="_blank"
          rel="noopener"
          aria-label="下载图片"
        >
          <i
            class="iconfont icon-xiazai"
            aria-hidden="true"
          ></i>
        </a>
        <button
          type="button"
          aria-label="关闭图片预览"
          @click="emit('close')"
        >
          <i
            class="iconfont icon-guanbichuangkou"
            aria-hidden="true"
          ></i>
        </button>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NModal } from 'naive-ui';
import { useImageGestures } from '@/hooks/useImageGestures';

defineProps<{ src: string; alt: string }>();
const emit = defineEmits<{ close: [] }>();
const viewport = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const ready = ref(false);
const loadError = ref(false);
const angle = ref(0);
const size = ref({ width: 0, height: 0 });
const fitted = computed(() => {
  if (!ready.value) return { width: 0, height: 0 };
  const { naturalWidth: width, naturalHeight: height } = image.value!;
  const turned = angle.value % 180 !== 0;
  const ratio = Math.min(
    1,
    size.value.width / (turned ? height : width),
    size.value.height / (turned ? width : height),
  );
  return { width: width * ratio, height: height * ratio };
});
const { transform, handlers, reset } = useImageGestures(viewport, {
  minScale: 1,
  maxScale: 5,
  enabled: () => ready.value,
  constrain: (value) => {
    const turned = angle.value % 180 !== 0;
    const maxX = Math.max(
      0,
      ((turned ? fitted.value.height : fitted.value.width) * value.scale - size.value.width) / 2,
    );
    const maxY = Math.max(
      0,
      ((turned ? fitted.value.width : fitted.value.height) * value.scale - size.value.height) / 2,
    );
    return {
      scale: value.scale,
      x: Math.max(-maxX, Math.min(maxX, value.x)),
      y: Math.max(-maxY, Math.min(maxY, value.y)),
    };
  },
});
const imageStyle = computed(() => ({
  width: `${fitted.value.width}px`,
  height: `${fitted.value.height}px`,
  visibility: ready.value ? ('visible' as const) : ('hidden' as const),
  transform: `translate(${transform.value.x}px, ${transform.value.y}px) rotate(${angle.value}deg) scale(${transform.value.scale})`,
}));

function loaded() {
  ready.value = true;
}
function rotate(degrees: number) {
  angle.value += degrees;
  reset();
}

const observer = new ResizeObserver(([entry]) => {
  size.value = { width: entry!.contentRect.width, height: entry!.contentRect.height };
  reset();
});
onMounted(() => observer.observe(viewport.value!));
onBeforeUnmount(() => observer.disconnect());
</script>

<style scoped>
.image-preview {
  width: 100vw;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.94);
  color: #fff;
}
.image-preview__viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  cursor: grab;
}
.image-preview__viewport:active {
  cursor: grabbing;
}
.image-preview__viewport img {
  flex: none;
  max-width: none;
  max-height: none;
  pointer-events: none;
}
.image-preview__viewport [role] {
  position: absolute;
}
.image-preview__toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 12px max(12px, env(safe-area-inset-bottom));
}
.image-preview__hint {
  font-size: 13px;
  color: #cbd5e1;
  margin-right: 12px;
}
.image-preview__toolbar button,
.image-preview__toolbar a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: #ffffff1f;
  color: #fff;
  cursor: pointer;
  text-decoration: none;
}
@media (max-width: 640px) {
  .image-preview__hint {
    width: 100%;
    margin: 0;
    text-align: center;
  }
}
</style>
