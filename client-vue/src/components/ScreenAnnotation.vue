<template>
  <div
    class="annotation-container"
    ref="containerRef"
  >
    <!-- 画布层 -->
    <canvas
      ref="canvasRef"
      class="annotation-canvas"
      :class="{ 'annotation-canvas--readonly': !editable }"
      @pointerdown="startDrawing"
      @pointermove="draw"
      @pointerup="stopDrawing"
      @pointercancel="stopDrawing"
      @pointerleave="stopDrawing"
    ></canvas>

    <!-- 标注工具栏 -->
    <div
      v-if="editable && showToolbar"
      ref="toolbarRef"
      class="annotation-toolbar"
      role="toolbar"
      aria-label="共享标注工具栏"
      :style="toolbarPositionStyle"
    >
      <div
        class="toolbar-header"
        @pointerdown="startToolbarDrag"
      >
        <div class="toolbar-title">
          <span
            class="toolbar-title-mark"
            aria-hidden="true"
          ></span>
          <strong>屏幕标注</strong>
          <span class="toolbar-hint">拖动这里可移动工具栏</span>
        </div>
        <n-button
          class="toolbar-close"
          size="tiny"
          quaternary
          @click="emit('close')"
          aria-label="关闭标注"
        >
          完成
        </n-button>
      </div>

      <div
        class="toolbar-tools"
        aria-label="标注形状"
      >
        <n-button
          v-for="tool in toolOptions"
          :key="tool.value"
          class="toolbar-tool"
          :class="{ 'toolbar-tool--active': currentTool === tool.value }"
          :type="currentTool === tool.value ? 'primary' : 'default'"
          :aria-pressed="currentTool === tool.value"
          size="small"
          @click="currentTool = tool.value"
        >
          <i
            class="tool-glyph iconfont"
            :class="`icon-${tool.icon}`"
            aria-hidden="true"
          ></i>
          {{ tool.label }}
        </n-button>
      </div>

      <div class="toolbar-footer">
        <div class="toolbar-setting toolbar-setting--color">
          <span class="setting-label">颜色</span>
          <n-popover
            trigger="click"
            placement="top"
            :show-arrow="false"
          >
            <template #trigger>
              <n-button
                class="color-trigger"
                size="small"
                aria-label="选择标注颜色"
              >
                <span
                  class="color-swatch"
                  :style="{ backgroundColor: currentColor }"
                  aria-hidden="true"
                ></span>
                <span>{{ currentColor.toUpperCase() }}</span>
              </n-button>
            </template>
            <div class="color-panel">
              <n-color-picker
                v-model:value="currentColor"
                :show-alpha="false"
                :modes="['hex']"
                :swatches="colorSwatches"
                aria-label="标注颜色"
              />
            </div>
          </n-popover>
        </div>
        <div class="toolbar-setting toolbar-setting--width">
          <span class="setting-label">粗细</span>
          <n-slider
            v-model:value="lineWidth"
            :min="1"
            :max="20"
            :step="1"
            aria-label="标注线条粗细"
          />
          <span class="width-value">{{ lineWidth }} px</span>
        </div>
        <div class="toolbar-actions">
          <n-button
            size="small"
            :disabled="actions.length === 0"
            @click="emit('undo')"
          >
            <template #icon>
              <i
                class="iconfont icon-chexiao"
                aria-hidden="true"
              ></i>
            </template>
            撤销
          </n-button>
          <n-button
            size="small"
            @click="emit('clear')"
          >
            <template #icon>
              <i
                class="iconfont icon-qingkong_qingkong"
                aria-hidden="true"
              ></i>
            </template>
            清空
          </n-button>
        </div>
      </div>
    </div>

    <!-- 文字输入对话框 -->
    <n-modal
      v-if="!isDesktopWindow"
      v-model:show="showTextInput"
      preset="dialog"
      title="输入文字"
    >
      <n-input
        v-model:value="textInput"
        type="textarea"
        placeholder="请输入文字..."
        :autosize="{ minRows: 3, maxRows: 5 }"
      />
      <template #action>
        <n-button @click="showTextInput = false">取消</n-button>
        <n-button
          type="primary"
          @click="confirmText"
        >
          确定
        </n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { isDesktopWindow } from '@/services/desktopAuxiliaryContext';
import { useDesktopDialogs } from '@/services/desktopDialogWindows';
import { useMessage } from 'naive-ui';
const openNativeDialog = useDesktopDialogs();
const message = useMessage();
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  type AnnotationAction,
  type AnnotationDraft,
  type AnnotationPoint,
  type AnnotationTool,
} from '@/services/screenAnnotationState';

const props = withDefaults(
  defineProps<{
    width?: number;
    height?: number;
    showToolbar?: boolean;
    editable: boolean;
    actions: AnnotationAction[];
    drafts: AnnotationDraft[];
  }>(),
  {
    showToolbar: false,
  },
);

const emit = defineEmits<{
  close: [];
  draft: [action: AnnotationDraft];
  complete: [action: AnnotationDraft];
  undo: [];
  clear: [];
}>();

// Refs
const containerRef = ref<HTMLDivElement>();
const canvasRef = ref<HTMLCanvasElement>();
const toolbarRef = ref<HTMLDivElement>();
const toolbarPosition = ref<{ left: number; top: number } | null>(null);
const toolbarPositionStyle = computed(() =>
  toolbarPosition.value
    ? {
        left: `${toolbarPosition.value.left}px`,
        top: `${toolbarPosition.value.top}px`,
        bottom: 'auto',
        transform: 'none',
      }
    : undefined,
);
let dragOffset: { x: number; y: number } | null = null;

function clampToolbarPosition(left: number, top: number) {
  const rect = toolbarRef.value?.getBoundingClientRect();
  const width = rect?.width || 0;
  const height = rect?.height || 0;
  const margin = 8;
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin)),
  };
}

function moveToolbar(event: PointerEvent) {
  if (!dragOffset) return;
  toolbarPosition.value = clampToolbarPosition(
    event.clientX - dragOffset.x,
    event.clientY - dragOffset.y,
  );
}

function stopToolbarDrag() {
  dragOffset = null;
  window.removeEventListener('pointermove', moveToolbar);
  window.removeEventListener('pointerup', stopToolbarDrag);
  window.removeEventListener('pointercancel', stopToolbarDrag);
}

function startToolbarDrag(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('button')) return;
  const rect = toolbarRef.value?.getBoundingClientRect();
  if (!rect) return;
  dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  window.addEventListener('pointermove', moveToolbar);
  window.addEventListener('pointerup', stopToolbarDrag);
  window.addEventListener('pointercancel', stopToolbarDrag);
  event.preventDefault();
}

function handleViewportResize() {
  initCanvas();
  if (toolbarPosition.value)
    toolbarPosition.value = clampToolbarPosition(
      toolbarPosition.value.left,
      toolbarPosition.value.top,
    );
}

watch(
  () => props.showToolbar,
  (show) => {
    if (!show) {
      stopToolbarDrag();
      toolbarPosition.value = null;
    }
  },
);

// 绘图状态
const isDrawing = ref(false);
const currentTool = ref<AnnotationTool>('pen');
const currentColor = ref('#FF0000');
const lineWidth = ref(3);
const currentActionId = ref('');
const currentPoints = ref<AnnotationPoint[]>([]);

// 文字输入
const showTextInput = ref(false);
const textInput = ref('');
const textPosition = ref<AnnotationPoint>({ x: 0, y: 0 });

// 颜色预设
const toolOptions: { value: AnnotationTool; label: string; icon: string }[] = [
  { value: 'pen', label: '画笔', icon: 'pen' },
  { value: 'line', label: '直线', icon: 'line' },
  { value: 'arrow', label: '箭头', icon: 'arrow' },
  { value: 'rect', label: '矩形', icon: 'rectangle' },
  { value: 'circle', label: '圆形', icon: 'circle' },
  { value: 'text', label: '文字', icon: 'text' },
  { value: 'eraser', label: '橡皮', icon: 'eraser' },
];

const colorSwatches = [
  '#FF0000',
  '#00FF00',
  '#0000FF',
  '#FFFF00',
  '#FF00FF',
  '#00FFFF',
  '#FFFFFF',
  '#000000',
];

let ctx: CanvasRenderingContext2D | null = null;
let resizeObserver: ResizeObserver | null = null;
let draftTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  initCanvas();
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.value);
  }
  window.addEventListener('resize', handleViewportResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleViewportResize);
  stopToolbarDrag();
  clearDraftTimer();
  resizeObserver?.disconnect();
});

function initCanvas() {
  if (!canvasRef.value || !containerRef.value) return;

  const canvas = canvasRef.value;
  const container = containerRef.value;
  canvas.width = props.width || container.clientWidth;
  canvas.height = props.height || container.clientHeight;

  ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  redraw();
}

function handleResize() {
  handleViewportResize();
}

function createActionId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

// 坐标按画布显示区域归一化，保证不同屏幕尺寸绘制在相同位置。
function getRelativePoint(event: PointerEvent): AnnotationPoint {
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return { x: 0, y: 0 };
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function getRelativeLineWidth() {
  const rect = canvasRef.value?.getBoundingClientRect();
  return lineWidth.value / Math.max(rect?.width || 1, rect?.height || 1);
}

function getCurrentDraft(): AnnotationDraft {
  return {
    actionId: currentActionId.value,
    tool: currentTool.value,
    points: [...currentPoints.value],
    color: currentColor.value,
    lineWidth: getRelativeLineWidth(),
  };
}

function startDrawing(event: PointerEvent) {
  if (!props.editable || showTextInput.value) return;
  event.preventDefault();
  currentActionId.value = createActionId();
  currentPoints.value = [getRelativePoint(event)];

  if (currentTool.value === 'text') {
    textPosition.value = currentPoints.value[0]!;
    showTextInput.value = true;
    if (isDesktopWindow) {
      void openNativeDialog({ kind: 'annotation', title: '输入文字', height: 360 })
        .then((value) => {
          textInput.value = typeof value === 'string' ? value : '';
          confirmText();
        })
        .catch((error) => {
          showTextInput.value = false;
          message.error(error.message);
        });
    }
    return;
  }

  canvasRef.value?.setPointerCapture?.(event.pointerId);
  isDrawing.value = true;
}

function draw(event: PointerEvent) {
  if (!props.editable || !isDrawing.value || !ctx) return;
  event.preventDefault();
  const point = getRelativePoint(event);
  if (['line', 'circle', 'rect', 'arrow'].includes(currentTool.value))
    currentPoints.value = [currentPoints.value[0]!, point];
  else currentPoints.value.push(point);
  redraw();
  drawAction(getCurrentDraft());
  scheduleDraft();
}

function stopDrawing(event?: PointerEvent) {
  if (!props.editable || !isDrawing.value) return;
  event?.preventDefault();
  if (event && event.type === 'pointerup') {
    const lastPoint = getRelativePoint(event);
    const previous = currentPoints.value[currentPoints.value.length - 1];
    if (!previous || previous.x !== lastPoint.x || previous.y !== lastPoint.y) {
      currentPoints.value.push(lastPoint);
    }
  }

  clearDraftTimer();
  const action = getCurrentDraft();
  if (action.points.length > 1) emit('complete', action);
  isDrawing.value = false;
  currentPoints.value = [];
  currentActionId.value = '';
  redraw();
}

function scheduleDraft() {
  if (draftTimer) return;
  draftTimer = setTimeout(() => {
    draftTimer = null;
    if (isDrawing.value) emit('draft', getCurrentDraft());
  }, 50);
}

function clearDraftTimer() {
  if (!draftTimer) return;
  clearTimeout(draftTimer);
  draftTimer = null;
}

function toCanvasPoint(point: AnnotationPoint): AnnotationPoint {
  return {
    x: point.x * (canvasRef.value?.width || 0),
    y: point.y * (canvasRef.value?.height || 0),
  };
}

function drawPath(points: AnnotationPoint[]) {
  if (!ctx || points.length < 2) return;
  const firstPoint = toCanvasPoint(points[0]!);
  ctx.beginPath();
  ctx.moveTo(firstPoint.x, firstPoint.y);
  points.slice(1).forEach((point) => {
    const canvasPoint = toCanvasPoint(point);
    ctx!.lineTo(canvasPoint.x, canvasPoint.y);
  });
  ctx.stroke();
}

function drawArrow(start: AnnotationPoint, end: AnnotationPoint) {
  if (!ctx) return;
  const canvasStart = toCanvasPoint(start);
  const canvasEnd = toCanvasPoint(end);
  const headLength = 15;
  const angle = Math.atan2(canvasEnd.y - canvasStart.y, canvasEnd.x - canvasStart.x);

  ctx.beginPath();
  ctx.moveTo(canvasStart.x, canvasStart.y);
  ctx.lineTo(canvasEnd.x, canvasEnd.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(canvasEnd.x, canvasEnd.y);
  ctx.lineTo(
    canvasEnd.x - headLength * Math.cos(angle - Math.PI / 6),
    canvasEnd.y - headLength * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(canvasEnd.x, canvasEnd.y);
  ctx.lineTo(
    canvasEnd.x - headLength * Math.cos(angle + Math.PI / 6),
    canvasEnd.y - headLength * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}

function drawRect(start: AnnotationPoint, end: AnnotationPoint) {
  if (!ctx) return;
  const canvasStart = toCanvasPoint(start);
  const canvasEnd = toCanvasPoint(end);
  ctx.beginPath();
  ctx.rect(canvasStart.x, canvasStart.y, canvasEnd.x - canvasStart.x, canvasEnd.y - canvasStart.y);
  ctx.stroke();
}

function drawText(point: AnnotationPoint, text: string, color: string, width: number) {
  if (!ctx) return;
  const canvasPoint = toCanvasPoint(point);
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${Math.max(12, width * 8)}px Arial`;
  ctx.fillText(text, canvasPoint.x, canvasPoint.y);
  ctx.restore();
}

function drawAction(action: AnnotationDraft | AnnotationAction) {
  if (!ctx || action.points.length === 0) return;
  const pixelLineWidth =
    action.lineWidth * Math.max(canvasRef.value?.width || 1, canvasRef.value?.height || 1);
  ctx.save();
  ctx.strokeStyle = action.color;
  ctx.lineWidth = pixelLineWidth;

  const start = action.points[0]!;
  const end = action.points[action.points.length - 1]!;
  switch (action.tool) {
    case 'pen':
      drawPath(action.points);
      break;
    case 'line':
      drawPath([start, end]);
      break;
    case 'circle': {
      const a = toCanvasPoint(start);
      const b = toCanvasPoint(end);
      ctx.beginPath();
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case 'arrow':
      drawArrow(start, end);
      break;
    case 'rect':
      drawRect(start, end);
      break;
    case 'text':
      if (action.text) drawText(start, action.text, action.color, pixelLineWidth);
      break;
    case 'eraser':
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = pixelLineWidth * 3;
      drawPath(action.points);
      break;
  }
  ctx.restore();
}

function confirmText() {
  const text = textInput.value.trim();
  if (text && props.editable) {
    emit('complete', {
      actionId: currentActionId.value,
      tool: 'text',
      points: [textPosition.value],
      color: currentColor.value,
      lineWidth: getRelativeLineWidth(),
      text,
    });
  }
  textInput.value = '';
  currentActionId.value = '';
  showTextInput.value = false;
}

function redraw() {
  if (!ctx || !canvasRef.value) return;
  ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);
  props.actions.forEach(drawAction);
  props.drafts.forEach(drawAction);
}

watch(
  () => [props.width, props.height, props.actions, props.drafts],
  () => initCanvas(),
  { deep: true },
);
</script>

<style scoped>
.annotation-container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.annotation-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  z-index: 10;
  touch-action: none;
  pointer-events: auto;
}

.annotation-canvas--readonly {
  cursor: default;
  pointer-events: none;
}

.annotation-toolbar {
  position: fixed;
  bottom: max(12px, env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, calc(100vw - 20px));
  max-height: min(240px, calc(100dvh - 16px));
  overflow: auto;
  padding: 10px 12px 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.94);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.36);
  color: #f8fafc;
  z-index: 1000;
  pointer-events: auto;
  backdrop-filter: blur(14px);
}

.toolbar-header,
.toolbar-title,
.toolbar-footer,
.toolbar-setting,
.toolbar-actions {
  display: flex;
  align-items: center;
}

.toolbar-header {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.toolbar-header:active {
  cursor: grabbing;
}
.toolbar-title {
  min-width: 0;
  gap: 8px;
  font-size: 13px;
  white-space: nowrap;
}
.toolbar-title-mark {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 8px #34d399;
}
.toolbar-hint {
  color: #94a3b8;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toolbar-close {
  flex: none;
}
.toolbar-tools {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 1px 0 8px;
  scrollbar-width: thin;
}
.toolbar-tool {
  flex: none;
}
.tool-glyph {
  margin-right: 6px;
  font-size: var(--icon-size-inline);
}
.toolbar-footer {
  flex-wrap: wrap;
  gap: 10px 16px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}
.toolbar-setting {
  gap: 8px;
  min-width: 0;
}
.toolbar-setting--color {
  flex: none;
}
.color-trigger :deep(.n-button__content) {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.color-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.85);
  border-radius: 4px;
}
.color-panel {
  width: 220px;
}
.toolbar-setting--width {
  flex: 1;
  min-width: 160px;
}
.toolbar-setting--width :deep(.n-slider) {
  flex: 1;
  min-width: 75px;
}
.setting-label,
.width-value {
  color: #cbd5e1;
  font-size: 12px;
  white-space: nowrap;
}
.width-value {
  width: 33px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.toolbar-actions {
  gap: 6px;
  margin-left: auto;
}
.annotation-toolbar :deep(.n-button:not(.n-button--primary-type)) {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.07);
}
.annotation-toolbar :deep(.n-button:not(.n-button--primary-type):hover) {
  background: rgba(255, 255, 255, 0.16);
}
.annotation-toolbar :deep(.n-button:not(.n-button--primary-type)::before) {
  border-color: rgba(255, 255, 255, 0.14);
}
.annotation-toolbar :deep(.n-button--primary-type) {
  color: #fff;
}

@media (max-width: 640px) {
  .annotation-toolbar {
    bottom: max(8px, env(safe-area-inset-bottom));
    padding: 9px;
    border-radius: 12px;
  }
  .toolbar-hint {
    display: none;
  }
  .toolbar-footer {
    gap: 8px;
  }
  .toolbar-setting--width {
    order: 2;
    flex-basis: 100%;
  }
  .toolbar-actions {
    margin-left: auto;
  }
}
</style>
