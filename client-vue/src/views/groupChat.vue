<template>
  <div
    ref="workspaceRef"
    class="group-workspace"
    :class="{ 'is-narrow': isNarrow, 'is-resizing': resizing, 'show-list': mobileListOpen || !groupId }"
    :style="{ '--group-list-width': `${listWidth}px` }"
  >
    <aside class="group-list-panel" aria-label="我的群组">
      <div class="group-list-heading">
        <h2>群组</h2>
        <n-button v-if="isNarrow && groupId" size="small" quaternary @click="mobileListOpen = false">返回聊天</n-button>
        <n-button size="small" secondary aria-label="创建或管理群组" @click="goToGroups">添加 / 管理</n-button>
      </div>
      <div class="group-list-search">
        <n-input v-model:value="groupKeyword" clearable placeholder="搜索群组" aria-label="搜索群组" />
      </div>
      <n-scrollbar ref="groupListScrollbarRef" class="group-list-scroll" @scroll="rememberListScroll">
        <div v-if="groupsError" class="list-notice">
          <p>{{ groupsError }}</p>
          <n-button size="small" @click="loadMyGroups">重新加载</n-button>
        </div>
        <n-empty v-else-if="!groupsLoading && filteredGroups.length === 0" class="group-empty" :description="groupKeyword ? '没有匹配的群组' : '暂无群组'" size="small" />
        <button
          v-for="group in filteredGroups"
          :key="group.id"
          type="button"
          class="group-item"
          :class="{ 'is-active': group.id === groupId }"
          :aria-current="group.id === groupId ? 'page' : undefined"
          @click="switchGroup(group)"
        >
          <n-avatar :size="40" :src="group.avatar || undefined">
            {{ group.name.charAt(0) }}
            <template #fallback>{{ group.name.charAt(0) }}</template>
          </n-avatar>
          <span class="group-item-text">
            <span class="group-item-name">{{ group.name }}</span>
            <span class="group-item-meta">{{ group.memberCount || 0 }} 位成员</span>
          </span>
          <n-badge :value="groupUnreadCount(group.id)" :max="99" :show="!!groupUnreadCount(group.id)" />
        </button>
      </n-scrollbar>
    </aside>
    <div
      v-if="!isNarrow"
      class="group-list-resizer"
      role="separator"
      tabindex="0"
      aria-label="调整群组列表宽度"
      aria-orientation="vertical"
      :aria-valuenow="listWidth"
      :aria-valuemin="260"
      :aria-valuemax="maxListWidth"
      data-no-drag
      @pointerdown="startListResize"
      @pointermove="resizeList"
      @pointerup="stopListResize"
      @pointercancel="stopListResize"
      @lostpointercapture="resizing = false"
      @keydown.left.prevent="setListWidth(listWidth - 10)"
      @keydown.right.prevent="setListWidth(listWidth + 10)"
    ></div>

    <section class="group-conversation">
      <header class="group-chat-header">
        <n-button v-if="isNarrow" secondary size="small" aria-label="打开群组列表" @click="mobileListOpen = true">群组</n-button>
        <div class="group-chat-heading">
          <h1>{{ groupInfo?.name || (groupId ? '加载群聊…' : '群组聊天') }}</h1>
          <p v-if="groupInfo?.description">{{ groupInfo.description }}</p>
        </div>
        <n-button v-if="groupId" size="small" :aria-expanded="showMembers" @click="membersOpen = !membersOpen">
          <span class="wide-action-label">{{ showMembers ? '收起成员' : '群成员' }}</span><span class="narrow-action-label">成员</span><template v-if="members.length"> · {{ members.length }}</template>
        </n-button>
      </header>
      <div class="group-conversation-body">
        <section v-if="groupId" class="group-chat-content">
          <div v-if="groupError" class="group-load-error" role="alert">
            <span>{{ groupError }}</span>
            <n-button size="small" @click="loadConversation">重新加载</n-button>
          </div>
          <!-- 消息列表 -->
          <n-scrollbar
            class="group-messages"
            ref="scrollbarRef"
            @scroll="rememberChatScroll"
          >
            <ChatMessageListState
              :status="historyStatus"
              :empty="messages.length === 0"
              group
              @retry="groupError ? loadConversation() : loadGroupHistory()"
            />
            <ul
              v-if="messages.length"
              class="space-y-4 p-6"
            >
              <li
                v-for="(msg, index) in messages"
                :key="msg.id || msg.clientMessageId || index"
                class="flex flex-col"
                @click.capture="actions?.click($event, actionMessage(msg))"
                :data-selecting="actions?.selecting"
                :class="msg.isMine ? 'items-end' : 'items-start'"
              >
                <input
                  v-if="actions?.selecting && msg.id"
                  class="message-selection"
                  type="checkbox"
                  :checked="actions.selectedIds.includes(msg.id)"
                  @change="actions.changeSelection($event, msg.id)"
                  aria-label="选择消息"
                />
                <div
                  class="group-message-row flex items-start gap-2 max-w-[88%] sm:max-w-[70%]"
                  :title="msg.time"
                >
                  <n-avatar
                    v-if="!actions?.selecting && !msg.isMine"
                    class="group-message-avatar shrink-0"
                    :size="32"
                    :src="msg.user?.avatar || undefined"
                  >
                    <span v-if="!msg.user?.avatar">
                      {{ msg.user?.nickname?.charAt(0) || msg.user?.username?.charAt(0) || '?' }}
                    </span>
                    <template #fallback>
                      <span class="flex h-full w-full items-center justify-center">
                        {{ msg.user?.nickname?.charAt(0) || msg.user?.username?.charAt(0) || '?' }}
                      </span>
                    </template>
                  </n-avatar>
                  <div class="min-w-0">
                    <div
                      v-if="!msg.isMine"
                      class="group-message-sender text-xs font-semibold text-gray-600 mb-1"
                    >
                      {{ msg.user?.nickname || msg.user?.username || '未知用户' }}
                    </div>
                    <div
                      class="message-action-target"
                      @contextmenu="actions?.open($event, actionMessage(msg))"
                      @pointerdown="actions?.pointerDown($event, actionMessage(msg))"
                      @pointermove="actions?.pointerMove($event)"
                      @pointerup="actions?.cancelPress()"
                      @pointercancel="actions?.cancelPress()"
                      @pointerleave="actions?.cancelPress()"
                    >
                      <ChatMessageContent
                        class="group-message-bubble"
                        :message="msg.message"
                        :quote="msg.quote"
                        :message-type="msg.messageType"
                        :media="msg.media"
                        :call="msg.call"
                        :is-mine="msg.isMine"
                      />
                    </div>
                    <button
                      v-if="msg.sendStatus && msg.sendStatus !== 'sent'"
                      type="button"
                      class="text-xs mt-1 text-gray-500"
                      @click="msg.sendStatus === 'failed' && retryGroupMessage(msg)"
                    >
                      {{ msg.sendStatus === 'pending' ? '发送中…' : '发送失败，点击重试' }}
                    </button>
                  </div>
                </div>
              </li>
            </ul>
          </n-scrollbar>

          <ChatMessageActions
            ref="actions"
            :key="groupId"
            kind="group"
            :conversation-id="groupId"
            :messages="messages.map(actionMessage)"
            :can-reply="canSpeak"
            @deleted="removeMessages"
            @forwarded="loadGroupHistory"
            @quote="focusComposer"
          />
          <!-- 输入框 -->
          <footer
            v-show="!actions?.selecting"
            class="group-chat-composer border-t bg-white"
          >
            <ChatMediaComposer
              :key="groupId"
              compact
              :disabled="!canSpeak"
              :group-id="groupId"
              @send="sendGroupMedia"
            >
              <template #toolbar>
                <ComposerToolButton
                  :label="groupSessionState.getButtonLabel(groupId, 'video')"
                  :disabled="callActionsDisabled"
                  @click="handleVideoCall"
                >
                  <i class="iconfont call-action-icon icon-video" aria-hidden="true"></i>
                </ComposerToolButton>
                <ComposerToolButton
                  :label="groupSessionState.getButtonLabel(groupId, 'audio')"
                  :disabled="callActionsDisabled"
                  @click="handleAudioCall"
                >
                  <i class="iconfont call-action-icon icon-dianhua" aria-hidden="true"></i>
                </ComposerToolButton>
                <ComposerToolButton
                  :label="groupSessionState.getButtonLabel(groupId, 'screen')"
                  :disabled="callActionsDisabled"
                  @click="handleScreenShare"
                >
                  <i class="iconfont call-action-icon icon-gongxiangpingmu" aria-hidden="true"></i>
                </ComposerToolButton>
              </template>
              <TextMsg
                :key="groupId"
                placeholder="请输入消息..."
                :disabled="!canSpeak"
                @send="handleSend"
              />
            </ChatMediaComposer>
            <div
              v-if="!canSpeak"
              class="text-xs text-red-500 mt-2"
            >
              您已被禁言，无法发送消息
            </div>
          </footer>

        </section>
        <div v-else class="group-chat-empty">
          <n-empty description="选择一个群组开始聊天" />
        </div>
        <button v-if="showMembers && !membersInline" class="members-backdrop" aria-label="关闭成员列表" @click="membersOpen = false"></button>
        <aside v-if="groupId && showMembers" class="group-members-panel" :class="{ 'is-overlay': !membersInline }" aria-label="群成员">
          <div class="members-heading">
            <h2>群成员 · {{ members.length }}</h2>
            <n-button v-if="!membersInline" size="tiny" quaternary @click="membersOpen = false">关闭</n-button>
          </div>
          <div class="members-search">
            <n-input v-model:value="memberKeyword" size="small" clearable placeholder="搜索成员" aria-label="搜索群成员" />
          </div>
          <n-scrollbar class="members-scroll">
            <ul class="member-list">
              <li v-for="member in filteredMembers" :key="member.id" class="member-item">
                <n-avatar :size="32" :src="member.avatar || undefined">
                  {{ (member.nickname || member.username).charAt(0) }}
                  <template #fallback>{{ (member.nickname || member.username).charAt(0) }}</template>
                </n-avatar>
                <div class="member-text">
                  <div class="member-name">{{ member.nickname || member.username }}</div>
                  <div class="member-tags">
                    <n-tag v-if="member.role === 'owner'" type="warning" size="tiny">群主</n-tag>
                    <n-tag v-else-if="member.role === 'admin'" type="info" size="tiny">管理员</n-tag>
                    <span v-if="member.canSpeak === false" class="member-muted">禁言</span>
                  </div>
                </div>
                <span class="member-presence" :class="{ 'is-online': member.online }" :aria-label="member.online ? '在线' : '离线'"></span>
              </li>
            </ul>
            <n-empty v-if="filteredMembers.length === 0" class="group-empty" description="暂无成员" size="small" />
          </n-scrollbar>
        </aside>
      </div>
    </section>
  </div>
</template>
<script setup lang="ts">
import { openScreenShare } from '@/features/screenShare';
import { isAppInBackground } from '@/services/appVisibility';
import { ref, computed, onActivated, onDeactivated, onBeforeUnmount, nextTick, watch } from 'vue';
import type { Socket } from 'socket.io-client';
import { useRoute, useRouter } from 'vue-router';
import { useMessage, type ScrollbarInst } from 'naive-ui';
import { getGroupDetail, getMyGroups, type Group, type GroupMember } from '@/api/group';
import { useAuthStore } from '@/stores/auth';
import { storeToRefs } from 'pinia';
import { useSocketStore } from '@/stores/socket';
import { useUnreadStore } from '@/stores/unread';
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { isDesktopWindow } from '@/services/desktopAuxiliaryContext';
import { openDesktopGroupWindow } from '@/services/desktopAuxiliaryWindows';
import { getGroupMessages, type ChatMediaPayload } from '@/api/message';
import { sendReliableMessage } from '@/services/reliableMessage';
import { applyMessageAck } from '@/services/messageDeliveryState';
import { groupSessionState } from '@/services/groupSessionState';
import TextMsg from '@/components/TextMsg.vue';
import ChatMediaComposer from '@/components/ChatMediaComposer.vue';
import ComposerToolButton from '@/components/ComposerToolButton.vue';
import ChatMessageContent from '@/components/ChatMessageContent.vue';
import ChatMessageActions from '@/components/ChatMessageActions.vue';
import ChatMessageListState from '@/components/ChatMessageListState.vue';

defineOptions({ name: 'GroupChatWorkspace' });

const route = useRoute();
const router = useRouter();
const message = useMessage();
const authStore = useAuthStore();
const { currentUser } = storeToRefs(authStore);
const socketStore = useSocketStore();
const unread = useUnreadStore();
const { socket } = storeToRefs(socketStore);

const workspaceRef = ref<HTMLElement | null>(null);
const groupListScrollbarRef = ref<ScrollbarInst | null>(null);
const scrollbarRef = ref<ScrollbarInst | null>(null);
const groupId = ref<number | null>(parseGroupId(route.params.id));
const groupInfo = ref<Group | null>(null);
const members = ref<(GroupMember & { online?: boolean })[]>([]);
const messages = ref<any[]>([]);
const historyStatus = ref<'loading' | 'ready' | 'error'>('loading');
const groupLoading = ref(false);
const groupError = ref('');
const myGroups = ref<Group[]>([]);
const groupKeyword = ref('');
const groupsLoading = ref(false);
const groupsError = ref('');
const memberKeyword = ref('');
const mobileListOpen = ref(false);
const membersOpen = ref(false);
const containerWidth = ref(0);
const listWidth = ref(300);
const resizing = ref(false);
const isNarrow = computed(() => containerWidth.value < 700);
const membersInline = computed(() => containerWidth.value >= 1060);
const showMembers = computed(() => !!groupId.value && membersOpen.value);
const maxListWidth = computed(() => Math.max(260, Math.min(420, containerWidth.value - (showMembers.value && membersInline.value ? 260 : 0) - 360)));
const filteredGroups = computed(() => {
  const keyword = groupKeyword.value.trim().toLowerCase();
  return keyword ? myGroups.value.filter(group => group.name.toLowerCase().includes(keyword)) : myGroups.value;
});
const filteredMembers = computed(() => {
  const keyword = memberKeyword.value.trim().toLowerCase();
  return keyword ? members.value.filter(member => (member.nickname || member.username).toLowerCase().includes(keyword)) : members.value;
});
let pageActive = false;
let listController: AbortController | null = null;
let conversationController: AbortController | null = null;
let historyController: AbortController | null = null;
let boundSocket: Socket | null = null;
let joinedGroupId: number | null = null;
let loadedGroupId: number | null = null;
let layoutObserver: ResizeObserver | null = null;
let listScrollTop = 0;
let chatScrollTop = 0;
let resizeStartX = 0;
let resizeStartWidth = 300;

function parseGroupId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function groupUnreadCount(id: number) { return unread.groupCounts[id] || 0; }
function setListWidth(width: number) { listWidth.value = Math.max(260, Math.min(maxListWidth.value, width)); }
function startListResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = listWidth.value;
  resizing.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function resizeList(event: PointerEvent) {
  if (resizing.value) setListWidth(resizeStartWidth + event.clientX - resizeStartX);
}
function stopListResize(event: PointerEvent) {
  resizing.value = false;
  const handle = event.currentTarget as HTMLElement;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
}
function rememberListScroll(event: Event) { listScrollTop = (event.target as HTMLElement).scrollTop; }
function rememberChatScroll(event: Event) { chatScrollTop = (event.target as HTMLElement).scrollTop; }
watch(maxListWidth, () => setListWidth(listWidth.value));
watch(membersInline, inline => { membersOpen.value = inline; });

const callActionsDisabled = computed(() => groupLoading.value || !!groupError.value || !groupInfo.value);

function switchGroup(group: Group) {
  mobileListOpen.value = false;
  if (group.id !== groupId.value) void router.push(`/group-chat/${group.id}`);
}
function resetConversation(id: number | null) {
  groupId.value = id;
  loadedGroupId = null;
  groupInfo.value = null;
  members.value = [];
  messages.value = [];
  memberKeyword.value = '';
  groupError.value = '';
  historyStatus.value = 'loading';
  chatScrollTop = 0;
  mobileListOpen.value = false;
}
watch(() => [route.name, route.params.id], () => {
  if (!pageActive || route.name !== 'GroupChat') return;
  const id = parseGroupId(route.params.id);
  if (id === groupId.value) return;
  resetConversation(id);
  void loadConversation();
});

const deletedMessageIds = new Set<number>();
const actions = ref<InstanceType<typeof ChatMessageActions> | null>(null);
function actionMessage(msg: any) {
  return {
    id: msg.id,
    message: msg.message,
    messageType: msg.messageType,
    senderName: msg.user?.nickname || msg.user?.username || '未知用户',
  };
}
function removeMessages(ids: number[]) {
  ids.forEach((id) => deletedMessageIds.add(id));
  messages.value = messages.value.filter((msg) => !ids.includes(msg.id));
}
function focusComposer() {
  nextTick(() => workspaceRef.value?.querySelector<HTMLElement>('.text-editor')?.focus());
}

watch([socket, () => socketStore.authenticated], ([, ready]) => {
  if (!pageActive) return;
  if (ready) void loadConversation();
  else unbindPageSocket();
});

const canSpeak = computed(() => {
  if (!groupId.value || !groupInfo.value || groupLoading.value || groupError.value) return false;
  return members.value.find(member => member.id === currentUser.value?.id)?.canSpeak === true;
});

async function loadConversation() {
  conversationController?.abort();
  historyController?.abort();
  unbindPageSocket();
  const id = groupId.value;
  if (!pageActive || !id) return;
  const controller = new AbortController();
  conversationController = controller;
  groupLoading.value = true;
  groupError.value = '';
  try {
    const detail = await getGroupDetail(id, controller.signal);
    if (controller.signal.aborted || !pageActive || groupId.value !== id) return;
    groupInfo.value = detail.group;
    const onlineIds = new Set(socketStore.userList.map(user => user.id));
    if (socketStore.authenticated && currentUser.value) onlineIds.add(currentUser.value.id);
    members.value = detail.members.map(member => ({ ...member, online: onlineIds.has(member.id) }));
    loadedGroupId = id;
    groupLoading.value = false;
    bindPageSocket();
    clearVisibleUnread();
    await loadGroupHistory();
  } catch (error) {
    if (!controller.signal.aborted && pageActive && groupId.value === id) {
      groupError.value = error instanceof Error ? error.message : '群组详情加载失败';
      historyStatus.value = 'error';
    }
  } finally {
    if (!controller.signal.aborted && conversationController === controller) groupLoading.value = false;
  }
}

async function loadGroupHistory() {
  const id = groupId.value;
  if (!pageActive || !id || loadedGroupId !== id) return;
  historyController?.abort();
  const controller = new AbortController();
  historyController = controller;
  const previousPosition = messages.value.length ? chatScrollTop : null;
  historyStatus.value = 'loading';
  try {
    const res = await getGroupMessages(id, 50, 0, controller.signal);
    if (controller.signal.aborted || !pageActive || groupId.value !== id) return;
    const history = res.messages.filter(msg => !deletedMessageIds.has(msg.id)).map(msg => ({
      id: msg.id, quote: msg.quote, message: msg.message,
      time: new Date(msg.createdAt).toLocaleString(), user: msg.sender,
      isMine: msg.userId === currentUser.value?.id, messageType: msg.messageType,
      call: msg.call, media: msg.media,
    }));
    // 历史请求期间收到的消息和待确认发送仍保留；同一服务器消息只展示一次。
    const confirmed = new Map<number, any>();
    for (const msg of messages.value) if (msg.id && !deletedMessageIds.has(msg.id)) confirmed.set(msg.id, msg);
    for (const msg of history) confirmed.set(msg.id, msg);
    messages.value = [
      ...[...confirmed.values()].sort((left, right) => left.id - right.id),
      ...messages.value.filter(msg => !msg.id),
    ];
    historyStatus.value = 'ready';
    await nextTick();
    if (controller.signal.aborted || !pageActive || groupId.value !== id) return;
    scrollbarRef.value?.scrollTo({ top: previousPosition ?? Number.MAX_SAFE_INTEGER, behavior: 'auto' });
  } catch (error) {
    if (controller.signal.aborted || !pageActive || groupId.value !== id) return;
    historyStatus.value = 'error';
    message.error('加载群聊记录失败: ' + (error instanceof Error ? error.message : '请稍后重试'));
  }
}

function bindPageSocket() {
  const id = groupId.value;
  const target = socket.value;
  if (!pageActive || !id || loadedGroupId !== id || !target || !socketStore.authenticated) return;
  if (boundSocket === target && joinedGroupId === id) return;
  unbindPageSocket();
  boundSocket = target;
  joinedGroupId = id;
  target.on('group_members', handleGroupMembers);
  target.on('group_member_joined', handleGroupMemberJoined);
  target.on('group_member_left', handleGroupMemberLeft);
  target.on('group_message', handleGroupMessage);
  socketStore.joinGroup(id);
}
function unbindPageSocket() {
  boundSocket?.off('group_members', handleGroupMembers);
  boundSocket?.off('group_member_joined', handleGroupMemberJoined);
  boundSocket?.off('group_member_left', handleGroupMemberLeft);
  boundSocket?.off('group_message', handleGroupMessage);
  boundSocket = null;
  if (joinedGroupId) socketStore.leaveGroup(joinedGroupId);
  joinedGroupId = null;
}

function handleGroupMembers(data: { groupId: number; members: any[] }) {
  if (!pageActive || data.groupId !== groupId.value) return;

  data.members.forEach((socketMember) => {
    const member = members.value.find((item) => item.id === socketMember.id);
    if (member) member.online = true;
  });
}

function handleGroupMemberJoined(data: { groupId: number; member: any }) {
  if (!pageActive || data.groupId !== groupId.value) return;

  const member = members.value.find((item) => item.id === data.member.id);
  if (member) member.online = true;
  message.info(`${data.member.nickname || data.member.username} 加入了群组`);
}

function handleGroupMemberLeft(_data: { socketId: string }) {
  // 在线状态由全局在线名单同步，避免同一用户的其他设备仍在线时误判为离线。
}

watch([() => socketStore.userList, () => socketStore.authenticated], ([users, ready]) => {
  const onlineIds = new Set(users.map((user) => user.id));
  if (ready && currentUser.value) onlineIds.add(currentUser.value.id);
  members.value.forEach((member) => {
    member.online = onlineIds.has(member.id);
  });
});

function handleGroupMessage(data: any) {
  if (!pageActive || data.groupId !== groupId.value || deletedMessageIds.has(data.id)) return;
  if (data.id && messages.value.some((msg) => msg.id === data.id)) return;

  messages.value.push({
    id: data.id,
    quote: data.quote,
    message: data.message,
    time: data.time,
    user: data.user,
    isMine: data.userId === currentUser.value?.id,
    messageType: data.messageType,
    call: data.call,
    media: data.media,
  });
  scrollToBottom();
}

// 发送消息
function handleSend(text: string) {
  if (!groupId.value) return;
  if (!canSpeak.value) {
    message.warning('您已被禁言');
    return;
  }

  const msg = {
    clientMessageId: crypto.randomUUID(),
    message: text,
    quote: actions.value?.takeQuote(),
    time: new Date().toLocaleString(),
    user: {
      id: currentUser.value?.id,
      username: currentUser.value?.username,
      nickname: currentUser.value?.nickname,
      avatar: currentUser.value?.avatar,
    },
    isMine: true,
    sendStatus: 'pending',
  };

  messages.value.push(msg);
  void retryGroupMessage(msg);

  scrollToBottom();
}

function sendGroupMedia(payload: { type: 'image' | 'voice'; media: ChatMediaPayload }) {
  if (!groupId.value) return;
  if (!canSpeak.value) {
    message.warning('您已被禁言');
    return;
  }
  const msg = {
    clientMessageId: crypto.randomUUID(),
    message: payload.type === 'image' ? '[图片]' : `[语音] ${payload.media.durationSeconds}秒`,
    messageType: payload.type,
    media: payload.media,
    quote: actions.value?.takeQuote(),
    time: new Date().toLocaleString(),
    user: {
      id: currentUser.value?.id,
      username: currentUser.value?.username,
      nickname: currentUser.value?.nickname,
      avatar: currentUser.value?.avatar,
    },
    isMine: true,
    sendStatus: 'pending',
  };
  messages.value.push(msg);
  void retryGroupMessage(msg);
  scrollToBottom();
}

// 滚动到底部
function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  const id = groupId.value;
  nextTick(() => {
    if (!pageActive || id !== groupId.value) return;
    scrollbarRef.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior });
  });
}

// 发起视频通话
function handleVideoCall() {
  if (!groupId.value) return;
  if (isDesktopWindow) {
    void openDesktopGroupWindow(`/group-video/${groupId.value}`).catch((error) =>
      message.warning(error.message),
    );
    return;
  }
  if (mediaOccupancy.current.value) {
    message.warning('请先结束当前通话或远程控制');
    return;
  }
  void router.push(`/group-video/${groupId.value}`);
}

function handleAudioCall() {
  if (!groupId.value) return;
  if (isDesktopWindow) {
    void openDesktopGroupWindow(`/group-audio/${groupId.value}`).catch((error) =>
      message.warning(error.message),
    );
    return;
  }
  if (mediaOccupancy.current.value) {
    message.warning('请先结束当前通话或远程控制');
    return;
  }
  void router.push(`/group-audio/${groupId.value}`);
}

// 发起屏幕共享
async function handleScreenShare() {
  if (!groupId.value) return;
  try {
    await openScreenShare({ kind: 'group', id: groupId.value }, router);
  } catch (error: any) {
    if (error?.name !== 'NotAllowedError') message.error(error.message);
  }
}

// 群列表与搜索状态由 KeepAlive 保留，请求只在工作区激活时执行。
async function loadMyGroups() {
  if (!pageActive) return;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  groupsLoading.value = true;
  groupsError.value = '';
  try {
    const res = await getMyGroups(controller.signal);
    if (!controller.signal.aborted && pageActive) myGroups.value = res.groups;
  } catch (error) {
    if (!controller.signal.aborted && pageActive) groupsError.value = error instanceof Error ? error.message : '群组列表加载失败';
  } finally {
    if (!controller.signal.aborted && listController === controller) groupsLoading.value = false;
  }
}

// 群组管理
function goToGroups() {
  router.push('/groups');
}

async function retryGroupMessage(msg: any) {
  const id = groupId.value;
  if (!msg.clientMessageId || !id) return;
  msg.sendStatus = 'pending';
  const result = await sendReliableMessage(socket.value, 'group_message', {
    groupId: id,
    message: msg.message,
    quote: msg.quote,
    messageType: msg.messageType,
    media: msg.media,
    clientMessageId: msg.clientMessageId,
  });
  if (groupId.value !== id) return;
  messages.value = applyMessageAck(messages.value, msg.clientMessageId, result);
}

function clearVisibleUnread() {
  if (pageActive && groupId.value && !isAppInBackground()) unread.readGroup(groupId.value);
}

function handleWorkspaceKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (isNarrow.value && mobileListOpen.value && groupId.value) mobileListOpen.value = false;
  else if (!membersInline.value) membersOpen.value = false;
}

function deactivateWorkspace() {
  pageActive = false;
  resizing.value = false;
  listController?.abort();
  conversationController?.abort();
  historyController?.abort();
  unbindPageSocket();
  layoutObserver?.disconnect();
  document.removeEventListener('keydown', handleWorkspaceKeydown);
  document.removeEventListener('visibilitychange', clearVisibleUnread);
  window.removeEventListener('focus', clearVisibleUnread);
}
onActivated(() => {
  pageActive = true;
  const id = parseGroupId(route.params.id);
  if (id !== groupId.value) resetConversation(id);
  layoutObserver ??= new ResizeObserver(([entry]) => {
    containerWidth.value = entry!.contentRect.width;
    if (isNarrow.value) resizing.value = false;
  });
  layoutObserver.observe(workspaceRef.value!);
  document.addEventListener('keydown', handleWorkspaceKeydown);
  document.addEventListener('visibilitychange', clearVisibleUnread);
  window.addEventListener('focus', clearVisibleUnread);
  void nextTick(() => groupListScrollbarRef.value?.scrollTo({ top: listScrollTop, behavior: 'auto' }));
  void loadMyGroups();
  void loadConversation();
});
onDeactivated(deactivateWorkspace);
onBeforeUnmount(deactivateWorkspace);
</script>

<style scoped>
.group-workspace {
  position: relative;
  display: flex;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #f8fafc;
}
.group-list-panel {
  flex: 0 0 var(--group-list-width);
  width: var(--group-list-width);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #e2e8f0;
  background: #f8fafc;
}
.group-list-heading,
.members-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px;
}
.group-list-heading h2,
.members-heading h2 { margin: 0; font-size: 14px; font-weight: 600; }
.group-list-search,
.members-search { flex: none; padding: 0 14px 14px; }
.group-list-scroll,
.members-scroll,
.group-messages { flex: 1; min-height: 0; }
.group-item {
  display: flex;
  width: calc(100% - 16px);
  align-items: center;
  gap: 10px;
  min-height: 68px;
  padding: 10px;
  margin: 3px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.group-item:hover { background: #e2e8f09e; }
.group-item.is-active { border-color: #dbeafe; background: #eff6ff; }
.group-item-text { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 3px; }
.group-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; color: #1e293b; }
.group-item-meta { color: #94a3b8; font-size: 11px; }
.group-empty { padding: 28px 12px; }
.list-notice { padding: 16px; color: #64748b; }
.group-list-resizer { position: absolute; z-index: 5; top: 0; bottom: 0; left: calc(var(--group-list-width) - 3px); width: 6px; cursor: col-resize; touch-action: none; }
.group-list-resizer:hover,
.group-list-resizer:focus-visible { background: #2563eb33; }
.is-resizing { cursor: col-resize; user-select: none; }
.group-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.group-chat-header { display: flex; flex: none; min-height: 72px; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #e2e8f0; background: #fff; }
.group-chat-heading { flex: 1; min-width: 0; }
.group-chat-heading h1 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; }
.group-chat-heading p { margin: 4px 0 0; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.group-conversation-body { display: flex; position: relative; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.group-chat-content { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.group-chat-empty { flex: 1; display: grid; place-items: center; padding: 24px; }
.group-load-error { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; background: #fff7ed; color: #9a3412; }
.group-members-panel { display: flex; flex: 0 0 260px; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid #e2e8f0; background: #fff; }
.group-members-panel.is-overlay { position: absolute; z-index: 22; inset: 0 0 0 auto; width: min(260px, 90%); box-shadow: -8px 0 24px #0f172a14; }
.members-backdrop { position: absolute; z-index: 21; inset: 0; border: 0; background: #0f172a40; }
.member-list { list-style: none; padding: 0 8px 12px; margin: 0; }
.member-item { display: flex; align-items: center; gap: 10px; padding: 10px 8px; border-radius: 8px; }
.member-item:hover { background: #f8fafc; }
.member-text { flex: 1; min-width: 0; }
.member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.member-tags { display: flex; gap: 4px; margin-top: 3px; }
.member-muted { color: #ef4444; font-size: 11px; }
.member-presence { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #cbd5e1; }
.member-presence.is-online { background: #4ade80; }
.group-chat-composer { flex: none; padding: 0; }
.message-action-target { -webkit-touch-callout: none; }
.message-selection { position: absolute; left: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; accent-color: #2563eb; }
li[data-selecting='true'] { position: relative; padding-left: 34px; background: #eff6ff55; border-radius: 8px; }
.is-narrow .group-list-panel { position: absolute; z-index: 30; inset: 0; width: 100%; transform: translateX(-101%); transition: transform .2s ease; }
.is-narrow.show-list .group-list-panel { transform: translateX(0); }
.is-narrow .group-chat-header { min-height: 64px; flex-wrap: wrap; padding: 10px 12px; gap: 8px; }
.is-narrow .group-chat-heading { order: -1; flex: 1 0 100%; }
.narrow-action-label { display: none; }
.is-narrow .wide-action-label { display: none; }
.is-narrow .narrow-action-label { display: inline; }
.is-narrow .group-list-heading { flex-wrap: wrap; }
.is-narrow .group-chat-composer { padding-bottom: env(safe-area-inset-bottom); }
@media (prefers-reduced-motion: reduce) { .is-narrow .group-list-panel { transition: none; } }
</style>
