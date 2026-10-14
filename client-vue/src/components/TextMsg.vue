<template>
  <div class="text-composer">
    <slot name="leading" />
    <div class="text-editor-wrap">
      <div
        ref="editorRef"
        class="text-editor"
        :contenteditable="!disabled"
        :aria-disabled="disabled"
        role="textbox"
        aria-label="消息"
        aria-multiline="true"
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
      ></div>
      <span
        v-if="!inputValue"
        class="text-placeholder"
      >
        {{ placeholder }}
      </span>
    </div>
    <button
      ref="sendButtonRef"
      class="send-button"
      type="button"
      aria-label="发送"
      title="发送"
      :disabled="disabled || !inputValue.trim()"
      @pointerdown.prevent
      @mousedown.prevent
      @click="handleSend"
    >
      <i
        class="iconfont icon-send"
        aria-hidden="true"
      ></i>
    </button>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue';

type MsgValue = string;

const props = withDefaults(
  defineProps<{
    value?: MsgValue;
    disabled?: boolean;
    placeholder?: string;
  }>(),
  {
    placeholder: '请输入...',
  },
);

const emits = defineEmits<{
  (e: 'update:value', value: MsgValue): void;
  (e: 'send', value: MsgValue): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
const sendButtonRef = ref<HTMLButtonElement | null>(null);
const defaultValue = ref(props.value || '');

const inputValue = computed({
  get: () => defaultValue.value,
  set: (v) => {
    defaultValue.value = v;
    emits('update:value', v);
  },
});

// 同步外部 v-model
watch(
  () => props.value,
  (v) => {
    if (v !== defaultValue.value) {
      defaultValue.value = v || '';
      if (editorRef.value && editorRef.value.innerText !== v) {
        editorRef.value.innerText = v || '';
      }
    }
  },
  { immediate: true },
);

// 输入事件
function onInput() {
  inputValue.value = editorRef.value?.innerText || '';
}

// 粘贴时过滤富文本样式
function onPaste(e: ClipboardEvent) {
  if (props.disabled) return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain');
  if (text) document.execCommand('insertText', false, text);
}

// 键盘事件：Enter 发送，Shift+Enter 换行
function onKeydown(e: KeyboardEvent) {
  if (props.disabled || e.isComposing) return;
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // Shift + Enter → 换行
      e.preventDefault();
      insertNewLine();
    } else {
      // Enter → 发送
      e.preventDefault();
      handleSend();
    }
  }
}

// 插入换行符（保持 contenteditable 结构）
function insertNewLine() {
  const selection = window.getSelection();

  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);

  const br = document.createElement('br');
  range.deleteContents();
  range.insertNode(br);
  range.setStartAfter(br);
  range.setEndAfter(br);
  selection.removeAllRanges();
  selection.addRange(range);
}

// 发送事件
function handleSend() {
  if (props.disabled) return;
  const text = inputValue.value.trim();
  if (!text) return;
  emits('send', text);
  // 清空
  inputValue.value = '';
  if (editorRef.value) editorRef.value.innerText = '';
}

function blurOnOutsidePointer(event: PointerEvent) {
  const editor = editorRef.value;
  // 等 click 完成发送；提前失焦会收起软键盘，导致按钮在手指松开前移位。
  if (sendButtonRef.value && event.composedPath().includes(sendButtonRef.value)) return;
  if (editor && editor === document.activeElement && !event.composedPath().includes(editor))
    editor.blur();
}

onMounted(() => {
  document.addEventListener('pointerdown', blurOnOutsidePointer, true);
  if (props.value && editorRef.value) {
    editorRef.value.innerText = props.value;
  }
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', blurOnOutsidePointer, true));
</script>

<style scoped>
.text-composer {
  display: flex;
  align-items: center;
  gap: 10px;
}
.text-editor-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  border-radius: 24px;
  background: #f1f5f9;
}
.text-editor-wrap:focus-within {
  box-shadow: inset 0 0 0 1px #bfdbfe;
}
.text-editor {
  min-height: 48px;
  max-height: 144px;
  padding: 13px 20px;
  outline: none;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 22px;
  color: #1e293b;
}
.text-placeholder {
  position: absolute;
  left: 20px;
  top: 13px;
  pointer-events: none;
  color: #94a3b8;
}
.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  flex: none;
  border-radius: 50%;
  background: #2563eb;
  color: white;
  font-size: 22px;
  box-shadow: 0 2px 5px #0f172a26;
}
.send-button:hover:not(:disabled) {
  background: #1d4ed8;
}
.send-button:disabled {
  cursor: not-allowed;
}
@media (max-width: 767px) {
  .text-composer {
    gap: 8px;
  }
  .text-editor {
    padding-inline: 14px;
    font-size: 16px;
  }
  .text-placeholder {
    left: 14px;
  }
}
</style>
