<template>
  <div
    v-if="selecting"
    class="selection-bar"
    role="toolbar"
    aria-label="多选消息操作"
  >
    <span>已选 {{ selectedIds.length }} 条</span>
    <n-button
      :disabled="!selectedIds.length"
      @click="openForward(selectedMessages)"
    >
      逐条转发
    </n-button>
    <n-button
      :disabled="!selectedIds.length"
      type="error"
      quaternary
      @click="confirmDelete(selectedMessages)"
    >
      删除
    </n-button>
    <n-button
      aria-label="退出多选"
      quaternary
      @click="exitSelection"
    >
      取消
    </n-button>
  </div>
  <div
    v-else-if="quote"
    class="quote-draft"
  >
    <div>
      <strong>{{ quote.senderName }}:</strong>
      <p>{{ quote.message }}</p>
    </div>
    <button
      type="button"
      aria-label="取消引用"
      @click="quote = null"
    >
      ×
    </button>
  </div>
  <n-dropdown
    :animated="false"
    style="min-width: 180px"
    :theme-overrides="{ optionHeightMedium: '42px', fontSizeMedium: '15px' }"
    :show="!!menu"
    :x="menu?.x ?? 0"
    :y="menu?.y ?? 0"
    placement="bottom-start"
    trigger="manual"
    :options="menuOptions"
    @select="chooseAction"
    @clickoutside="menu = null"
  />
  <n-modal
    :show="forwardMessages.length > 0"
    :mask-closable="!sending"
    @update:show="closeForward"
  >
    <!-- vueuc 的焦点陷阱通过 div 根节点识别弹窗内容。 -->
    <div
      class="forward-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="转发消息"
    >
      <div class="forward-contacts">
        <h3>转发消息</h3>
        <n-input
          v-model:value="search"
          placeholder="搜索联系人或群聊"
          clearable
          aria-label="搜索联系人或群聊"
        />
        <p class="section-label">联系人与群聊</p>
        <div v-if="loading">加载中…</div>
        <div
          v-else
          class="recipient-list"
        >
          <label
            v-for="target in filteredTargets"
            :key="target.key"
            class="recipient"
          >
            <input
              v-model="recipientKeys"
              type="checkbox"
              :value="target.key"
              :disabled="sending"
            />
            <n-avatar
              :src="target.avatar || undefined"
              :size="36"
            >
              {{ target.name.charAt(0) }}
            </n-avatar>
            <span>
              {{ target.name }}
              <small v-if="target.kind === 'group'">群聊</small>
            </span>
          </label>
          <n-empty
            v-if="!filteredTargets.length"
            description="没有匹配的会话"
          />
        </div>
      </div>
      <div class="forward-preview">
        <h3>发送给</h3>
        <div class="recipient-tags">
          <n-tag
            v-for="target in selectedTargets"
            :key="target.key"
          >
            {{ target.name }}
          </n-tag>
        </div>
        <div class="forward-summary">
          <p
            v-for="item in forwardMessages"
            :key="item.id"
          >
            {{ item.message }}
          </p>
        </div>
        <n-input
          v-model:value="note"
          placeholder="留言"
          :disabled="sending"
          maxlength="10000"
        />
        <div class="forward-buttons">
          <n-button
            type="primary"
            :loading="sending"
            :disabled="!recipientKeys.length || loading"
            @click="sendForward"
          >
            发送
          </n-button>
          <n-button
            :disabled="sending"
            @click="closeForward"
          >
            取消
          </n-button>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useDialog, useMessage } from 'naive-ui';
import {
  CopyOutline,
  ArrowRedoOutline,
  ChatboxEllipsesOutline,
  CheckboxOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import { h } from 'vue';
import { getUserList } from '@/api/auth';
import { getMyGroups } from '@/api/group';
import type { MessageQuote } from '@/api/message';
import { useAuthStore } from '@/stores/auth';
import { useSocketStore } from '@/stores/socket';
import { sendReliableMessage } from '@/services/reliableMessage';

export interface ActionMessage {
  id?: number;
  message: string;
  senderName: string;
  messageType?: string;
}
const props = withDefaults(
  defineProps<{
    kind: 'private' | 'group';
    conversationId: number;
    messages: ActionMessage[];
    canReply?: boolean;
  }>(),
  { canReply: true },
);
const emit = defineEmits<{ deleted: [ids: number[]]; forwarded: []; quote: [] }>();
const socketStore = useSocketStore();
const auth = useAuthStore();
const toast = useMessage();
const dialog = useDialog();
const menu = ref<{ x: number; y: number; message: ActionMessage; element: HTMLElement } | null>(
  null,
);
const quote = ref<MessageQuote | null>(null);
const selecting = ref(false);
const selectedIds = ref<number[]>([]);
const selectedMessages = computed(() =>
  props.messages.filter((item) => item.id && selectedIds.value.includes(item.id)),
);
const menuOptions = computed(() => [
  {
    label: '复制',
    key: 'copy',
    icon: () => h(CopyOutline, { style: { width: '20px', height: '20px' } }),
    disabled:
      menu.value?.message.messageType === 'image' || menu.value?.message.messageType === 'voice',
  },
  {
    label: '转发',
    key: 'forward',
    icon: () => h(ArrowRedoOutline, { style: { width: '20px', height: '20px' } }),
  },
  {
    label: '引用',
    key: 'quote',
    icon: () => h(ChatboxEllipsesOutline, { style: { width: '20px', height: '20px' } }),
    disabled: props.canReply === false,
  },
  {
    label: '多选',
    key: 'select',
    icon: () => h(CheckboxOutline, { style: { width: '20px', height: '20px' } }),
  },
  { type: 'divider', key: 'divider' },
  {
    label: '删除',
    key: 'delete',
    icon: () => h(TrashOutline, { style: { width: '20px', height: '20px' } }),
  },
]);
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressOrigin = { x: 0, y: 0 };
let suppressClick = false;
function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = undefined;
}
function open(event: MouseEvent | PointerEvent, item: ActionMessage) {
  if (!item.id || selecting.value) return;
  event.preventDefault();
  menu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 270)),
    message: item,
    element: event.currentTarget as HTMLElement,
  };
}
function pointerDown(event: PointerEvent, item: ActionMessage) {
  cancelPress();
  suppressClick = false;
  if (event.pointerType === 'mouse' || selecting.value || !item.id) return;
  pressOrigin = { x: event.clientX, y: event.clientY };
  const element = event.currentTarget as HTMLElement;
  pressTimer = setTimeout(() => {
    suppressClick = true;
    menu.value = {
      x: Math.max(8, Math.min(pressOrigin.x, window.innerWidth - 180)),
      y: Math.max(8, Math.min(pressOrigin.y, window.innerHeight - 270)),
      message: item,
      element,
    };
  }, 500);
}
function pointerMove(event: PointerEvent) {
  if (Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > 10) cancelPress();
}
function click(event: MouseEvent, item: ActionMessage) {
  // 复选框由 change 处理，避免行点击取消或覆盖原生勾选过程。
  if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') return;
  if (suppressClick || selecting.value) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (selecting.value && item.id) toggle(item.id);
  suppressClick = false;
}
function changeSelection(event: Event, id: number) {
  toggle(id);
  // 达到上限时原生控件已经勾选，需要恢复为实际业务状态。
  (event.target as HTMLInputElement).checked = selectedIds.value.includes(id);
}
function toggle(id: number) {
  if (selectedIds.value.includes(id))
    selectedIds.value = selectedIds.value.filter((value) => value !== id);
  else if (selectedIds.value.length < 100) selectedIds.value.push(id);
  else toast.warning('一次最多选择 100 条消息');
}
function exitSelection() {
  selecting.value = false;
  selectedIds.value = [];
}
async function chooseAction(key: string) {
  const current = menu.value;
  if (!current) return;
  menu.value = null;
  if (key === 'copy') {
    const element = current.element.querySelector('.chat-text') || current.element;
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    try {
      await navigator.clipboard.writeText(current.message.message);
      toast.success('已复制');
    } catch {
      toast.error('复制失败，请使用系统复制操作');
    }
  } else if (key === 'quote') {
    quote.value = {
      id: current.message.id!,
      kind: props.kind,
      senderName: current.message.senderName,
      message: current.message.message,
    };
    emit('quote');
  } else if (key === 'select') {
    selecting.value = true;
    selectedIds.value = [current.message.id!];
  } else if (key === 'forward') await openForward([current.message]);
  else if (key === 'delete') confirmDelete([current.message]);
}
function confirmDelete(items: ActionMessage[]) {
  const ids = items.map((item) => item.id!);
  const kind = props.kind;
  dialog.warning({
    title: '删除消息',
    content: '所选消息将从你的所有设备上删除',
    positiveText: '删除消息',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      try {
        if (!socketStore.socket?.connected) throw new Error('连接已断开，请稍后重试');
        const result = await socketStore.socket
          .timeout(10000)
          .emitWithAck('messages_delete', { kind, ids });
        if (!result?.ok) throw new Error(result?.error || '删除失败');
        emit('deleted', ids);
        exitSelection();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '删除失败');
        return false;
      }
    },
  });
}
function onDeleted(data: { kind: string; ids: number[] }) {
  if (data.kind !== props.kind) return;
  emit('deleted', data.ids);
  selectedIds.value = selectedIds.value.filter((id) => !data.ids.includes(id));
  if (quote.value && data.ids.includes(quote.value.id)) quote.value = null;
  if (menu.value?.message.id && data.ids.includes(menu.value.message.id)) menu.value = null;
}
watch(
  () => socketStore.socket,
  (current, previous) => {
    previous?.off('messages_deleted', onDeleted);
    current?.on('messages_deleted', onDeleted);
  },
  { immediate: true },
);

type Target = { kind: 'private' | 'group'; id: number; key: string; name: string; avatar?: string };
const targets = ref<Target[]>([]);
const recipientKeys = ref<string[]>([]);
const search = ref('');
const note = ref('');
const loading = ref(false);
const sending = ref(false);
const forwardMessages = ref<ActionMessage[]>([]);
const filteredTargets = computed(() =>
  targets.value.filter((target) =>
    target.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
  ),
);
const selectedTargets = computed(() =>
  targets.value.filter((target) => recipientKeys.value.includes(target.key)),
);
// 保留每次发送的幂等标识，部分失败后重试不会重复发送成功的消息。
const deliveries = new Map<string, { id: string; done: boolean }>();
let forwardGeneration = 0;
async function openForward(items: ActionMessage[]) {
  forwardMessages.value = [...items];
  targets.value = [];
  recipientKeys.value = [];
  search.value = '';
  note.value = '';
  deliveries.clear();
  const generation = ++forwardGeneration;
  loading.value = true;
  try {
    const [users, groups] = await Promise.all([getUserList(), getMyGroups()]);
    if (generation !== forwardGeneration) return;
    targets.value = [
      ...users.users
        .filter((user) => user.id !== auth.currentUser?.id)
        .map((user) => ({
          kind: 'private' as const,
          id: user.id,
          key: `private:${user.id}`,
          name: user.nickname || user.username,
          avatar: user.avatar,
        })),
      ...groups.groups.map((group) => ({
        kind: 'group' as const,
        id: group.id,
        key: `group:${group.id}`,
        name: group.name,
      })),
    ];
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '加载会话失败');
  } finally {
    if (generation === forwardGeneration) loading.value = false;
  }
}
function closeForward() {
  if (sending.value) return;
  forwardGeneration++;
  forwardMessages.value = [];
}
async function sendForward() {
  if (sending.value) return;
  sending.value = true;
  const kind = props.kind;
  const generation = forwardGeneration;
  try {
    for (const target of selectedTargets.value) {
      const messages = forwardMessages.value.map((item) => ({
        key: String(item.id),
        payload: { forward: { kind, id: item.id } } as Record<string, unknown>,
      }));
      if (note.value.trim())
        messages.push({
          key: `note:${note.value.trim()}`,
          payload: { message: note.value.trim() },
        });
      for (const item of messages) {
        if (generation !== forwardGeneration) return;
        const key = `${target.key}:${item.key}`;
        const delivery = deliveries.get(key) || { id: crypto.randomUUID(), done: false };
        deliveries.set(key, delivery);
        if (delivery.done) continue;
        const result = await sendReliableMessage(
          socketStore.socket,
          target.kind === 'private' ? 'private_message' : 'group_message',
          {
            ...item.payload,
            ...(target.kind === 'private' ? { to: { id: target.id } } : { groupId: target.id }),
            clientMessageId: delivery.id,
          },
        );
        if (!result.ok) throw new Error(`${target.name}：${result.error}`);
        delivery.done = true;
      }
    }
    if (generation !== forwardGeneration) return;
    toast.success('已转发');
    forwardMessages.value = [];
    exitSelection();
    emit('forwarded');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '转发失败');
  } finally {
    sending.value = false;
  }
}
function takeQuote() {
  const value = quote.value;
  quote.value = null;
  return value || undefined;
}
watch(
  () => props.conversationId,
  () => {
    cancelPress();
    menu.value = null;
    quote.value = null;
    exitSelection();
    forwardGeneration++;
    forwardMessages.value = [];
  },
);
onBeforeUnmount(() => {
  cancelPress();
  forwardGeneration++;
  socketStore.socket?.off('messages_deleted', onDeleted);
});
defineExpose({
  open,
  pointerDown,
  pointerMove,
  cancelPress,
  click,
  changeSelection,
  selecting,
  selectedIds,
  takeQuote,
});
</script>

<style scoped>
.selection-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 14px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 28px;
  box-shadow: 0 8px 30px #0f172a12;
  margin: 12px;
}
.quote-draft {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  margin: 12px 16px;
  padding: 12px 16px;
  border-left: 4px solid #cbd5e1;
  border-radius: 5px;
  background: #f5f6f8;
  color: #64748b;
}
.quote-draft p {
  margin: 4px 0 0;
  max-height: 72px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.quote-draft button {
  align-self: flex-start;
  border: 0;
  background: transparent;
  font-size: 24px;
  cursor: pointer;
}
.forward-dialog {
  width: min(860px, calc(100vw - 32px));
  height: min(600px, calc(100dvh - 48px));
  display: grid;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
  background: white;
  border-radius: 16px;
  box-shadow: 0 20px 80px #0f172a26;
}
.forward-contacts,
.forward-preview {
  min-height: 0;
  min-width: 0;
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.forward-contacts {
  background: #f5f7fa;
}
h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.section-label {
  margin: 4px 0 0;
  color: #64748b;
}
.recipient-list {
  overflow: auto;
  flex: 1;
}
.recipient {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  cursor: pointer;
}
.recipient input {
  width: 18px;
  height: 18px;
  accent-color: #2563eb;
}
.recipient span {
  overflow-wrap: anywhere;
}
.recipient small {
  margin-left: 8px;
  color: #94a3b8;
}
.recipient-tags {
  flex: 1;
  display: flex;
  align-content: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  overflow: auto;
}
.forward-summary {
  background: #f5f6f8;
  border-left: 3px solid #d1d5db;
  color: #64748b;
  padding: 12px;
  max-height: 150px;
  overflow: auto;
  overflow-wrap: anywhere;
}
.forward-summary p {
  margin: 0 0 6px;
  white-space: pre-wrap;
}
.forward-buttons {
  display: flex;
  gap: 12px;
}
.forward-buttons > * {
  flex: 1;
}
@media (max-width: 600px) {
  .forward-dialog {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(180px, 1fr) auto;
  }
  .forward-contacts,
  .forward-preview {
    padding: 16px;
    gap: 10px;
  }
  .forward-summary {
    max-height: 65px;
  }
  .recipient-tags {
    max-height: 64px;
    flex: initial;
  }
  .selection-bar {
    gap: 5px;
    padding: 10px;
    margin: 8px;
    font-size: 12px;
  }
}
</style>
