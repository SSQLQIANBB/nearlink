<template>
  <div
    ref="pageRef"
    class="im-page"
    :class="{ 'is-resizing': resizing }"
  >
    <n-layout
      has-sider
      class="remote-shell h-full w-full"
      :class="{ 'sidebar-open': mobileSidebarOpen }"
    >
      <button
        v-if="mobileSidebarOpen"
        class="sidebar-backdrop"
        aria-label="关闭联系人列表"
        @click="mobileSidebarOpen = false"
      ></button>
      <n-layout-sider
        class="remote-sidebar"
        :class="{ 'mobile-open': mobileSidebarOpen }"
        bordered
        :width="sidebarWidth"
        :collapsed-width="0"
        collapse-mode="transform"
        :show-trigger="false"
        content-class="remote-sidebar-content flex flex-col"
      >
        <n-button
          class="mobile-sidebar-close"
          secondary
          @click="mobileSidebarOpen = false"
        >
          关闭列表
        </n-button>
        <!-- 用户信息卡片 -->
        <div class="sidebar-profile p-4 text-white">
          <div class="sidebar-profile-main flex items-center gap-3 mb-3">
            <n-avatar
              :size="40"
              :src="authUser?.avatar || undefined"
              class="profile-avatar cursor-pointer ring-2 ring-white ring-opacity-50 bg-[#E7F2FF] text-[#137FFF] font-bold"
              @click="goToProfile"
            >
              <span v-if="!authUser?.avatar">
                {{ authUser?.nickname?.charAt(0) || authUser?.username?.charAt(0) || '?' }}
              </span>
              <template #fallback>
                <span class="flex h-full w-full items-center justify-center">
                  {{ authUser?.nickname?.charAt(0) || authUser?.username?.charAt(0) || '?' }}
                </span>
              </template>
            </n-avatar>
            <div class="flex-1">
              <div class="font-bold text-sm">
                {{ authUser?.nickname || authUser?.username || '未登录' }}
              </div>
              <div class="flex items-center gap-2 mt-1">
                <span
                  class="w-2 h-2 rounded-full animate-pulse"
                  :class="getStatusColor(userStatus)"
                ></span>
                <span class="text-xs opacity-90">{{ getStatusText(userStatus) }}</span>
              </div>
            </div>
            <n-button
              class="sidebar-logout"
              title="退出登录"
              aria-label="退出登录"
              type="error"
              size="small"
              strong
              secondary
              @click="handleLogout"
            >
              <i
                class="iconfont icon-logout"
                aria-hidden="true"
              ></i>
            </n-button>
          </div>
          <!-- 快捷操作 -->
          <div
            class="sidebar-profile-actions"
            :class="{ 'sidebar-profile-actions--desktop': desktop }"
          >
            <n-button
              class="profile-button"
              size="small"
              secondary
              @click="goToProfile"
            >
              <template #icon>
                <i
                  class="iconfont icon-id-card"
                  aria-hidden="true"
                ></i>
              </template>
              个人中心
            </n-button>
            <n-button
              v-if="desktop"
              class="profile-button"
              size="small"
              secondary
              :aria-pressed="showRemoteControl"
              @click="showRemoteControl = !showRemoteControl"
            >
              远程控制
            </n-button>
          </div>
        </div>

        <!-- Tab 切换 -->
        <n-tabs
          v-model:value="activeTab"
          type="line"
          animated
          justify-content="space-evenly"
          class="sidebar-tabs flex-1 min-h-0 flex flex-col"
          pane-class="flex-1"
          style="overflow: hidden"
        >
          <!-- 联系人 -->
          <n-tab-pane
            name="users"
            :tab="unread.privateTotal ? `联系人 (${unread.privateTotal})` : '联系人'"
            display-directive="show:lazy"
            class="flex flex-col h-full min-h-0 pt-0"
          >
            <div
              class="sidebar-section-header px-4 py-3 text-xs font-semibold flex items-center justify-between gap-2"
            >
              <span>联系人 ({{ displayUsers.length }})</span>
              <span
                v-if="unread.privateTotal > 0"
                class="contact-unread-badge"
                aria-label="未读消息"
              >
                {{ unread.privateTotal > 99 ? '99+' : unread.privateTotal }}
              </span>
            </div>
            <n-scrollbar class="flex-1 min-h-0">
              <ul class="contact-list p-2 space-y-1">
                <n-badge
                  :offset="[-8, 8]"
                  class="w-full"
                  :value="unReadMessageCount[user.id] || 0"
                  :max="99"
                  :show="!!unReadMessageCount[user.id]"
                  v-for="user in displayUsers"
                  :key="user.id"
                >
                  <li
                    class="contact-item w-full flex items-center gap-3 cursor-pointer transition-all"
                    :class="
                      contactUser?.id === user.id
                        ? 'bg-blue-100 border-blue-300 shadow-md'
                        : 'bg-white border-gray-200'
                    "
                    @click="selectContact(user)"
                  >
                    <n-avatar
                      :size="40"
                      :src="user.avatar || undefined"
                      class="flex-shrink-0"
                    >
                      <span v-if="!user.avatar">
                        {{ user.nickname?.charAt(0) || user.username?.charAt(0) || '?' }}
                      </span>
                      <template #fallback>
                        <span class="flex h-full w-full items-center justify-center">
                          {{ user.nickname?.charAt(0) || user.username?.charAt(0) || '?' }}
                        </span>
                      </template>
                    </n-avatar>
                    <div class="flex-1 w-0">
                      <div class="font-semibold text-sm">
                        {{ user.nickname || user.username || `用户-${user.id}` }}
                      </div>
                      <div class="text-xs text-gray-500 truncate">
                        {{ user.bio || '人很懒，无简介~' }}
                      </div>
                    </div>
                    <div
                      class="w-2 h-2 rounded-full"
                      :class="getStatusColor(user?.status || 'online')"
                    ></div>
                  </li>
                </n-badge>

                <n-empty
                  v-if="!displayUsers.length"
                  class="h-full flex items-center justify-center py-12"
                  description="暂无联系人"
                  size="small"
                >
                  <template #icon>
                    <n-icon
                      size="32"
                      color="#d0d0d0"
                    >
                      <i
                        class="iconfont icon-user"
                        aria-hidden="true"
                      ></i>
                    </n-icon>
                  </template>
                </n-empty>
              </ul>
            </n-scrollbar>
          </n-tab-pane>

          <!-- 我的群组 -->
          <n-tab-pane
            name="groups"
            :tab="unread.groupTotal ? `我的群组 (${unread.groupTotal})` : '我的群组'"
            display-directive="show:lazy"
            class="flex flex-col h-full min-h-0 pt-0"
          >
            <div
              class="sidebar-section-header px-4 py-3 text-xs font-semibold flex items-center justify-between"
            >
              <span>我的群组 ({{ myGroups.length }})</span>
              <n-button
                size="tiny"
                @click="goToGroups"
              >
                管理
              </n-button>
            </div>
            <n-scrollbar class="flex-1 min-h-0">
              <div class="p-3">
                <n-button
                  block
                  secondary
                  @click="goToGroups"
                  class="mb-3"
                >
                  + 创建/管理群组
                </n-button>

                <div
                  v-if="myGroups.length > 0"
                  class="space-y-2 mt-3"
                >
                  <div
                    v-for="group in myGroups"
                    :key="group.id"
                    class="group-item flex items-center gap-3 cursor-pointer transition-all"
                    @click="goToGroupChat(group.id)"
                  >
                    <n-avatar
                      :size="40"
                      :src="group.avatar || undefined"
                    >
                      <span v-if="!group.avatar">{{ group.name?.charAt(0) || 'G' }}</span>
                      <template #fallback>
                        <span class="flex h-full w-full items-center justify-center">
                          {{ group.name?.charAt(0) || 'G' }}
                        </span>
                      </template>
                    </n-avatar>
                    <div class="flex-1 min-w-0">
                      <div class="font-semibold text-sm truncate">{{ group.name }}</div>
                      <div class="text-xs text-gray-500">成员: {{ group.memberCount || 0 }}</div>
                    </div>
                    <n-badge
                      :value="unread.groupCounts[group.id] || 0"
                      :max="99"
                      :show="!!unread.groupCounts[group.id]"
                    />
                  </div>
                </div>

                <n-empty
                  v-else
                  description="暂无群组"
                  size="small"
                  class="py-8"
                >
                  <template #extra>
                    <n-button
                      size="small"
                      @click="goToGroups"
                    >
                      创建群组
                    </n-button>
                  </template>
                </n-empty>
              </div>
            </n-scrollbar>
          </n-tab-pane>
        </n-tabs>
        <div
          v-if="!desktop"
          class="sidebar-download"
        >
          <DesktopReleaseEntry variant="sidebar" />
        </div>
      </n-layout-sider>

      <div
        class="sidebar-resizer"
        :style="{ left: `${sidebarWidth - 3}px` }"
        role="separator"
        aria-label="调整联系人栏宽度"
        aria-orientation="vertical"
        :aria-valuenow="sidebarWidth"
        :aria-valuemin="280"
        :aria-valuemax="maxSidebarWidth"
        tabindex="0"
        data-no-drag
        @pointerdown="startSidebarResize"
        @pointermove="resizeSidebar"
        @pointerup="stopSidebarResize"
        @pointercancel="stopSidebarResize"
        @lostpointercapture="resizing = false"
        @keydown.left.prevent="setSidebarWidth(sidebarWidth - 10)"
        @keydown.right.prevent="setSidebarWidth(sidebarWidth + 10)"
        @keydown.home.prevent="setSidebarWidth(280)"
        @keydown.end.prevent="setSidebarWidth(maxSidebarWidth)"
      ></div>

      <n-layout-content content-class="w-full flex flex-col">
        <RemoteControlWorkbench v-if="showRemoteControl" />
        <div
          v-else-if="contactUser"
          class="chat-panel h-full w-full flex flex-col"
        >
          <!-- 聊天头部 -->
          <header class="chat-header min-h-16 flex items-center px-3 sm:px-6 py-2">
            <n-button
              class="mobile-sidebar-toggle"
              secondary
              aria-label="打开联系人列表"
              @click="mobileSidebarOpen = true"
            >
              <i
                class="iconfont icon-bars"
                aria-hidden="true"
              ></i>
            </n-button>
            <div class="flex items-center gap-3 w-0 flex-grow overflow-hidden">
              <n-avatar
                :size="36"
                :src="contactUser.avatar || undefined"
                class="flex-shrink-0"
              >
                <span v-if="!contactUser.avatar">
                  {{ contactUser.nickname?.charAt(0) || contactUser.username?.charAt(0) || '?' }}
                </span>
                <template #fallback>
                  <span class="flex h-full w-full items-center justify-center">
                    {{ contactUser.nickname?.charAt(0) || contactUser.username?.charAt(0) || '?' }}
                  </span>
                </template>
              </n-avatar>
              <div class="flex-grow-1 w-auto overflow-hidden">
                <div class="font-bold text-sm">
                  {{ contactUser.nickname || contactUser.username || `用户-${contactUser.id}` }}
                </div>
                <div class="text-xs text-nowrap text-gray-500 truncate">
                  {{ contactUser.bio || '人很懒，无简介~' }}
                </div>
              </div>
            </div>
          </header>
          <n-scrollbar
            class="message-scrollbar grow"
            ref="scrollbarRef"
          >
            <ChatMessageListState
              :status="historyStatus"
              :empty="currentMessageList.length === 0"
              @retry="selectContact(contactUser)"
            />
            <ul
              v-if="currentMessageList.length"
              class="message-list space-y-4"
            >
              <li
                class="message-item flex flex-col w-full relative"
                @click.capture="actions?.click($event, actionMessage(msg))"
                :data-selecting="actions?.selecting"
                :class="msg.fromUserId === authUser?.id ? 'items-end' : 'items-start'"
                v-for="(msg, index) in currentMessageList"
                :key="msg.id || msg.clientMessageId || index"
              >
                <input
                  v-if="actions?.selecting && msg.id"
                  class="message-selection"
                  type="checkbox"
                  :checked="actions.selectedIds.includes(msg.id)"
                  @change="actions.changeSelection($event, msg.id)"
                  aria-label="选择消息"
                />
                <n-avatar
                  v-if="!actions?.selecting && msg.fromUserId !== authUser?.id"
                  class="incoming-avatar"
                  :size="32"
                  :src="contactUser.avatar || undefined"
                >
                  <span v-if="!contactUser.avatar">
                    {{ (contactUser.nickname || contactUser.username).charAt(0) }}
                  </span>
                  <template #fallback>
                    <span class="flex h-full w-full items-center justify-center">
                      {{ (contactUser.nickname || contactUser.username).charAt(0) }}
                    </span>
                  </template>
                </n-avatar>
                <div
                  class="message-entry"
                  :title="msg.time"
                  :class="[
                    msg.fromUserId === authUser?.id
                      ? 'message-entry--mine'
                      : 'message-entry--theirs',
                    { 'message-entry--call': msg.messageType === 'call' },
                  ]"
                >
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
                      :message="msg.message"
                      :quote="msg.quote"
                      :message-type="msg.messageType"
                      :media="msg.media"
                      :call="msg.call"
                      :is-mine="msg.fromUserId === authUser?.id"
                    />
                  </div>
                </div>
                <button
                  v-if="msg.sendStatus && msg.sendStatus !== 'sent'"
                  type="button"
                  class="message-status text-xs mt-1"
                  @click="msg.sendStatus === 'failed' && retryPrivateMessage(msg)"
                >
                  {{ msg.sendStatus === 'pending' ? '发送中…' : '发送失败，点击重试' }}
                </button>
              </li>
            </ul>
          </n-scrollbar>

          <ChatMessageActions
            ref="actions"
            kind="private"
            :conversation-id="contactUser.id"
            :messages="currentMessageList.map(actionMessage)"
            @deleted="removeMessages"
            @forwarded="selectContact(contactUser!)"
            @quote="focusComposer"
          />
          <div
            v-show="!actions?.selecting"
            class="message-composer-shell"
          >
            <ChatMediaComposer
              compact
              @send="sendMedia"
            >
              <template #toolbar>
                <ToolBar :contact-user="contactUser" />
              </template>
              <TextMsg
                placeholder="请输入消息..."
                @send="sendMsg"
              />
            </ChatMediaComposer>
          </div>
        </div>
        <div
          class="chat-empty-state h-full w-full flex flex-col items-center justify-center"
          v-else
        >
          <div class="empty-icon">
            <i
              class="iconfont regular icon-comments"
              aria-hidden="true"
            ></i>
          </div>
          <h3>开启高效远程协作</h3>
          <p>
            请从左侧列表选择一个联系人开始聊天。您可以发送文字、语音片段、图片，或者发起高清音视频通话与屏幕共享。
          </p>
          <n-button
            type="primary"
            @click="
              activeTab = 'users';
              mobileSidebarOpen = true;
            "
          >
            <template #icon>
              <i
                class="iconfont icon-address-book"
                aria-hidden="true"
              ></i>
            </template>
            打开联系人列表
          </n-button>
        </div>
      </n-layout-content>
    </n-layout>
  </div>
</template>

<script lang="ts" setup>
import { useWindowDialog } from '@/services/useWindowDialog';
import { isTauri } from '@tauri-apps/api/core';
import RemoteControlWorkbench from '@/components/RemoteControlWorkbench.vue';
import { isAppInBackground } from '@/services/appVisibility';
import { onMounted, onUnmounted, ref, nextTick, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Socket } from 'socket.io-client';
import { storeToRefs } from 'pinia';
import { useMessage, useDialog } from 'naive-ui';
import { useAuthStore } from '@/stores/auth';
import { getUserList, type User as BasicUser } from '@/api/auth';
import { useSocketStore, type OnlineUser } from '@/stores/socket';
import { useUnreadStore } from '@/stores/unread';
import { getMyGroups, type Group } from '@/api/group';
import {
  getOfflineMessages,
  getPrivateMessages,
  markMessagesAsRead,
  type CallHistoryRecord,
  type ChatMediaPayload,
} from '@/api/message';
import { sendReliableMessage } from '@/services/reliableMessage';
import { applyMessageAck } from '@/services/messageDeliveryState';
import {
  getPendingInvitations,
  acceptInvitation,
  rejectInvitation,
  type GroupInvitation,
} from '@/api/invitation';
import TextMsg from '@/components/TextMsg.vue';
import ChatMediaComposer from '@/components/ChatMediaComposer.vue';
import ChatMessageContent from '@/components/ChatMessageContent.vue';
import ChatMessageActions from '@/components/ChatMessageActions.vue';
import ChatMessageListState from '@/components/ChatMessageListState.vue';
import type { MessageQuote } from '@/api/message';
import ToolBar from './components/ToolBar.vue';
import notificationService from '@/services/notificationService';
import { mergeContactPresence } from '@/services/contactPresence';
import { getRemoteTabQuery, parseRemoteTab, type RemoteTab } from '@/services/remoteTabState';

const router = useRouter();
const desktop = isTauri();
const showRemoteControl = ref(false);
const route = useRoute();
const authStore = useAuthStore();
const { currentUser: authUser, token } = storeToRefs(authStore);
const socketStore = useSocketStore();
const unread = useUnreadStore();
const { socket, authenticated: online, userList } = storeToRefs(socketStore);
const activeTab = ref<RemoteTab>(parseRemoteTab(route.query.tab));
const mobileSidebarOpen = ref(false);
const pageRef = ref<HTMLElement | null>(null);
const sidebarWidth = ref(320);
const maxSidebarWidth = ref(420);
const resizing = ref(false);
let resizeStartX = 0;
let resizeStartWidth = 320;
let layoutObserver: ResizeObserver;

function setSidebarWidth(width: number) {
  sidebarWidth.value = Math.max(280, Math.min(maxSidebarWidth.value, width));
}
function startSidebarResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = sidebarWidth.value;
  resizing.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function resizeSidebar(event: PointerEvent) {
  if (resizing.value) setSidebarWidth(resizeStartWidth + event.clientX - resizeStartX);
}
function stopSidebarResize(event: PointerEvent) {
  resizing.value = false;
  const handle = event.currentTarget as HTMLElement;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
}
onMounted(() => {
  // 观察实际容器，兼顾网页外边距与桌面窗口缩放。
  layoutObserver = new ResizeObserver(([entry]) => {
    if (entry!.contentRect.width < 768) resizing.value = false;
    maxSidebarWidth.value = Math.max(280, Math.min(420, entry!.contentRect.width - 480));
    setSidebarWidth(sidebarWidth.value);
  });
  layoutObserver.observe(pageRef.value!.firstElementChild!);
});
onUnmounted(() => layoutObserver.disconnect());

type User = OnlineUser;

type MessageInfo = {
  id?: number;
  clientMessageId?: string;
  sendStatus?: 'pending' | 'sent' | 'failed';
  time: string;
  from?: string;
  fromUserId: number;
  toUserId?: number;
  message: string;
  messageType?: 'text' | 'call' | 'image' | 'voice';
  quote?: MessageQuote;
  call?: CallHistoryRecord;
  media?: ChatMediaPayload;
};

const message = useMessage();
const dialog = useDialog();
const windowDialog = useWindowDialog();

const contactUser = ref<User | null>(null);
const knownContacts = ref<BasicUser[]>([]);

const myGroups = ref<Group[]>([]);
const pendingInvitations = ref<GroupInvitation[]>([]);

// 计算用户状态（基于Socket连接状态）
const userStatus = computed(() => {
  if (!online.value) return 'offline';
  return authUser.value?.status || 'online';
});

// 获取状态颜色
function getStatusColor(status: string) {
  const colors: Record<string, string> = {
    online: 'bg-green-300',
    busy: 'bg-yellow-300',
    offline: 'bg-gray-300',
  };
  return colors[status] || 'bg-gray-300';
}

// 获取状态文本
function getStatusText(status: string) {
  const texts: Record<string, string> = {
    online: '在线',
    busy: '忙碌',
    offline: '离线',
  };
  return texts[status] || '离线';
}

// 私信本地存储
const privateMessageMap = new Map<User['id'], MessageInfo[]>();

const unReadMessageCount = computed(() => unread.privateCounts);
const displayUsers = computed<User[]>(() => {
  return mergeContactPresence(
    knownContacts.value,
    Object.values(unread.privateContacts),
    userList.value,
    authUser.value?.id,
  );
});

async function loadContacts() {
  try {
    knownContacts.value = (await getUserList()).users;
  } catch (error) {
    console.error('加载联系人失败:', error);
  }
}
const currentMessageList = ref<MessageInfo[]>([]);
const historyStatus = ref<'loading' | 'ready' | 'error'>('ready');
let historyRequest = 0;

const deletedMessageIds = new Set<number>();
const actions = ref<InstanceType<typeof ChatMessageActions> | null>(null);
function actionMessage(msg: MessageInfo) {
  return {
    id: msg.id,
    message: msg.message,
    messageType: msg.messageType,
    senderName:
      (msg.fromUserId === authUser.value?.id ? authUser.value : contactUser.value)?.nickname ||
      (msg.fromUserId === authUser.value?.id ? authUser.value : contactUser.value)?.username ||
      '未知用户',
  };
}
function removeMessages(ids: number[]) {
  ids.forEach((id) => deletedMessageIds.add(id));
  for (const [id, list] of privateMessageMap)
    privateMessageMap.set(
      id,
      list.filter((msg) => !msg.id || !ids.includes(msg.id)),
    );
  currentMessageList.value = contactUser.value
    ? privateMessageMap.get(contactUser.value.id) || []
    : [];
}
function focusComposer() {
  nextTick(() => document.querySelector<HTMLElement>('.text-editor')?.focus());
}

watch(
  () => socketStore.authenticated,
  (ready, previous) => {
    if (ready && previous === false && contactUser.value) void selectContact(contactUser.value);
  },
);

// refs
const scrollbarRef = ref();

// 退出登录
function handleLogout() {
  windowDialog.info({
    positiveButtonProps: { type: 'primary' },
    title: '退出登录？',
    content: '确认退出当前账号吗？',
    positiveText: '退出登录',
    negativeText: '取消',
    onPositiveClick: () => authStore.logout({ navigate: true }),
  });
}

// 私信
function handlePrivateMessage(data: any) {
  console.log('receive-message:', data);

  const senderId = Number(data.fromUserId);
  setMessage(senderId, {
    id: data.id,
    from: data.from,
    fromUserId: senderId,
    toUserId: data.toUserId,
    quote: data.quote,
    message: data.message,
    messageType: data.messageType,
    media: data.media,
    time:
      data.time ||
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
  });

  if (senderId === contactUser.value?.id) {
    currentMessageList.value = privateMessageMap.get(senderId) || [];
    scrollToBottom();
  }
}

function handlePrivateCallHistory(data: any) {
  if (!authUser.value) return;
  const contactId =
    data.fromUserId === authUser.value.id ? Number(data.toUserId) : Number(data.fromUserId);
  if (!contactId) return;

  setMessage(contactId, {
    id: data.id,
    fromUserId: Number(data.fromUserId),
    toUserId: Number(data.toUserId),
    quote: data.quote,
    message: data.message,
    messageType: data.messageType,
    call: data.call,
    time:
      data.time ||
      new Date(data.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
  });

  if (contactId === contactUser.value?.id) {
    currentMessageList.value = privateMessageMap.get(contactId) || [];
    scrollToBottom();
  }
}

function setMessage(id: number, data: MessageInfo) {
  if (data.id && deletedMessageIds.has(data.id)) return;
  const list = privateMessageMap.get(id) || [];
  if (data.id && list.some((message) => message.id === data.id)) return;

  privateMessageMap.set(id, [...list, data]);
}

function bindPageSocketEvents(target: Socket) {
  target.on('private_message', handlePrivateMessage);
  target.on('private_call_history', handlePrivateCallHistory);
}

function unbindPageSocketEvents(target: Socket | null | undefined) {
  target?.off('private_message', handlePrivateMessage);
  target?.off('private_call_history', handlePrivateCallHistory);
}

async function selectContact(user: User) {
  const request = ++historyRequest;
  historyStatus.value = 'loading';
  currentMessageList.value = privateMessageMap.get(user.id) || [];
  showRemoteControl.value = false;
  mobileSidebarOpen.value = false;
  contactUser.value = user;
  unread.activePrivateUserId = user.id;

  try {
    const res = await getPrivateMessages(user.id);
    if (request !== historyRequest) return;
    const history = res.messages
      .filter((msg) => !deletedMessageIds.has(msg.id))
      .map((msg) => ({
        fromUserId: msg.fromUserId,
        toUserId: msg.toUserId,
        quote: msg.quote,
        message: msg.message,
        messageType: msg.messageType,
        call: msg.call,
        media: msg.media,
        id: msg.id,
        time: new Date(msg.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      }));
    privateMessageMap.set(user.id, history);
    currentMessageList.value = history;
    historyStatus.value = 'ready';
    scrollToBottom('auto');
    if (!isAppInBackground()) {
      const ids = res.messages
        .filter((msg) => msg.fromUserId === user.id && !msg.isRead)
        .map((msg) => msg.id);
      if (ids.length) await markMessagesAsRead(ids);
      unread.readPrivate(user.id);
    }
  } catch (error: any) {
    if (request !== historyRequest) return;
    if (historyStatus.value === 'loading') historyStatus.value = 'error';
    message.error('加载聊天记录失败: ' + error.message);
    currentMessageList.value = privateMessageMap.get(user.id) || [];
    scrollToBottom('auto');
  }
}
function sendMsg(v: string) {
  console.log(v);
  if (!contactUser.value || !authUser.value) return;

  // 私信
  const msg: MessageInfo = {
    clientMessageId: crypto.randomUUID(),
    sendStatus: 'pending',
    from: socket.value?.id!,
    fromUserId: authUser.value.id,
    toUserId: contactUser.value.id,
    message: v,
    quote: actions.value?.takeQuote(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
  setMessage(contactUser.value.id, msg);
  void retryPrivateMessage(msg);

  currentMessageList.value = privateMessageMap.get(contactUser.value.id) || [];
  scrollToBottom();
}

function sendMedia(payload: { type: 'image' | 'voice'; media: ChatMediaPayload }) {
  if (!contactUser.value || !authUser.value) return;
  const msg: MessageInfo = {
    clientMessageId: crypto.randomUUID(),
    sendStatus: 'pending',
    from: socket.value?.id,
    fromUserId: authUser.value.id,
    toUserId: contactUser.value.id,
    message: payload.type === 'image' ? '[图片]' : `[语音] ${payload.media.durationSeconds}秒`,
    messageType: payload.type,
    media: payload.media,
    quote: actions.value?.takeQuote(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
  setMessage(contactUser.value.id, msg);
  currentMessageList.value = privateMessageMap.get(contactUser.value.id) || [];
  void retryPrivateMessage(msg);
  scrollToBottom();
}

async function retryPrivateMessage(msg: MessageInfo) {
  if (!msg.toUserId || !msg.clientMessageId) return;
  const toUserId = msg.toUserId;
  const clientMessageId = msg.clientMessageId;
  msg.sendStatus = 'pending';
  const target = contactUser.value?.id === toUserId ? contactUser.value : { id: toUserId };
  const result = await sendReliableMessage(socket.value, 'private_message', {
    to: target,
    message: msg.message,
    quote: msg.quote,
    messageType: msg.messageType,
    media: msg.media,
    clientMessageId,
  });
  const updated = applyMessageAck(privateMessageMap.get(toUserId) || [], clientMessageId, result);
  privateMessageMap.set(toUserId, updated);
  if (contactUser.value?.id === toUserId) currentMessageList.value = updated;
}

// 滚动到底部
function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  nextTick(() => {
    scrollbarRef.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior });
  });
}

// 加载群组列表
async function loadMyGroups() {
  try {
    const res = await getMyGroups();
    myGroups.value = res.groups || [];
    socketStore.setSubscribedGroups(myGroups.value.map((group) => group.id));
  } catch (error: any) {
    console.error('加载群组列表失败:', error);
  }
}

// 将离线私信纳入未读列表，不再打断当前页面
async function loadOfflineMessages() {
  try {
    const res = await getOfflineMessages();
    res.messages?.forEach((item) => {
      unread.rememberSender(item.sender);
      unread.receivePrivate(item.id, item.fromUserId, false);
    });
  } catch (error) {
    console.error('加载离线消息失败:', error);
  }
}

// 加载群组邀请
async function loadPendingInvitations() {
  try {
    const res = await getPendingInvitations();
    pendingInvitations.value = res.invitations || [];

    if (pendingInvitations.value.length > 0) {
      if (isAppInBackground()) {
        pendingInvitations.value.forEach((inv) => {
          void notificationService.showInvitation(
            inv.group.name,
            inv.inviter.nickname || inv.inviter.username,
            inv.inviter.avatar,
            () => {
              window.focus();
              showInvitationsDialog();
            },
          );
        });
      } else {
        notificationService.playAlert('invitation');
      }

      // 显示邀请对话框
      showInvitationsDialog();
    }
  } catch (error: any) {
    console.error('加载群组邀请失败:', error);
  }
}

// 显示群组邀请对话框
function showInvitationsDialog() {
  if (pendingInvitations.value.length === 0) return;

  const invitation = pendingInvitations.value[0];
  if (!invitation) return;

  dialog.warning({
    positiveButtonProps: { type: 'primary' },
    title: '群组邀请',
    content: `${invitation.inviter?.nickname || invitation.inviter?.username || '某用户'} 邀请您加入群组 "${invitation.group?.name || '未知群组'}"`,
    positiveText: '接受',
    negativeText: '拒绝',
    onPositiveClick: async () => {
      try {
        if (!invitation?.id) return;
        await acceptInvitation(invitation.id);
        message.success('已加入群组');
        pendingInvitations.value = pendingInvitations.value.filter(
          (inv) => inv.id !== invitation.id,
        );
        loadMyGroups(); // 重新加载群组列表

        // 如果还有其他邀请，继续显示
        if (pendingInvitations.value.length > 0) {
          setTimeout(() => showInvitationsDialog(), 500);
        }
      } catch (error: any) {
        message.error('接受邀请失败: ' + error.message);
      }
    },
    onNegativeClick: async () => {
      try {
        if (!invitation?.id) return;
        await rejectInvitation(invitation.id);
        message.info('已拒绝邀请');
        pendingInvitations.value = pendingInvitations.value.filter(
          (inv) => inv.id !== invitation.id,
        );

        // 如果还有其他邀请，继续显示
        if (pendingInvitations.value.length > 0) {
          setTimeout(() => showInvitationsDialog(), 500);
        }
      } catch (error: any) {
        message.error('拒绝邀请失败: ' + error.message);
      }
    },
  });
}

// 跳转到个人中心
const goToProfile = () => {
  router.push('/profile');
};

// 跳转到群组管理
const goToGroups = () => {
  router.push('/groups');
};

// 跳转到群组聊天
const goToGroupChat = (groupId: number) => {
  router.push(`/group-chat/${groupId}`);
};

// 监听消息列表变化，自动滚动到底部
watch(
  () => currentMessageList.value.length,
  () => {
    scrollToBottom();
  },
);

watch(activeTab, (tab) => {
  if (route.query.tab === tab) return;
  void router.replace({
    path: '/remote',
    query: getRemoteTabQuery(tab),
  });
});

watch(
  [displayUsers, () => route.query.contact],
  ([users, contact]) => {
    const selected = users.find((item) => item.id === contactUser.value?.id);
    if (selected && contactUser.value !== selected) contactUser.value = selected;
    const user = users.find((item) => item.id === Number(contact));
    if (user && contactUser.value?.id !== user.id) void selectContact(user);
  },
  { immediate: true },
);

watch(
  () => route.query.tab,
  (tab) => {
    activeTab.value = parseRemoteTab(tab);
  },
);

watch(
  socket,
  (nextSocket, previousSocket) => {
    unbindPageSocketEvents(previousSocket);
    if (nextSocket) bindPageSocketEvents(nextSocket);
  },
  { immediate: true },
);

const handleVisible = () => {
  if (!isAppInBackground()) {
    if (contactUser.value && unReadMessageCount.value[contactUser.value.id]) {
      void selectContact(contactUser.value);
    }
  }
};
onMounted(async () => {
  document.addEventListener('visibilitychange', handleVisible);
  window.addEventListener('focus', handleVisible);

  if (authUser.value && token.value) {
    await Promise.all([
      loadContacts(),
      loadMyGroups(),
      loadOfflineMessages(),
      loadPendingInvitations(),
    ]);
  }
});

onUnmounted(() => {
  historyRequest++;
  unbindPageSocketEvents(socket.value);
  unread.activePrivateUserId = null;
  document.removeEventListener('visibilitychange', handleVisible);
  window.removeEventListener('focus', handleVisible);
});
</script>

<style scoped>
.message-action-target {
  -webkit-touch-callout: none;
}
.message-selection {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  accent-color: #2563eb;
}
li[data-selecting='true'] {
  position: relative;
  padding-left: 34px;
  background: #eff6ff55;
  border-radius: 8px;
}
.mobile-sidebar-toggle .iconfont {
  font-size: var(--icon-size-control);
}
.remote-shell {
  position: relative;
  background: #f1f5f9;
  color: #1e293b;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.sidebar-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 30;
  cursor: col-resize;
  touch-action: none;
}
.sidebar-resizer:hover,
.sidebar-resizer:focus-visible,
.is-resizing .sidebar-resizer {
  background: #2563eb55;
}
.sidebar-resizer:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px #2563eb;
}
.is-resizing {
  user-select: none;
  cursor: col-resize;
}
:deep(.remote-sidebar) {
  transition: none;
}
@media (max-width: 767px) {
  .sidebar-resizer {
    display: none;
  }
}

:deep(.remote-sidebar) {
  border-right: 1px solid rgba(203, 213, 225, 0.76);
  box-shadow: none;
}

:deep(.remote-sidebar-content) {
  background: #f8fafc;
  box-shadow: none;
}

.sidebar-profile {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.1);
}

.sidebar-profile-main {
  min-height: 48px;
}

.sidebar-profile-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.sidebar-profile-actions--desktop {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.sidebar-download {
  order: 3;
  flex-shrink: 0;
  padding: 12px 16px 16px;
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
}

.sidebar-profile-actions .profile-button {
  width: 100%;
  min-width: 0;
}

.profile-avatar {
  box-shadow: 0 8px 22px rgba(30, 64, 175, 0.24);
}

:deep(.sidebar-logout),
:deep(.profile-button) {
  --n-color: rgba(255, 255, 255, 0.13) !important;
  --n-color-hover: rgba(255, 255, 255, 0.22) !important;
  --n-color-pressed: rgba(255, 255, 255, 0.28) !important;
  --n-text-color: rgba(255, 255, 255, 0.9) !important;
  --n-text-color-hover: #fff !important;
  --n-border: 1px solid rgba(255, 255, 255, 0.14) !important;
  --n-border-hover: 1px solid rgba(255, 255, 255, 0.24) !important;
  border-radius: 9px;
  backdrop-filter: blur(10px);
}

:deep(.sidebar-tabs .n-tabs-nav) {
  flex: none;
  border-bottom: 1px solid #e2e8f0;
  background: #fff;
}

:deep(.sidebar-tabs) {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

:deep(.sidebar-tabs .n-tabs-pane-wrapper),
:deep(.sidebar-tabs .n-tab-pane) {
  min-height: 0;
  flex: 1;
}

:deep(.sidebar-tabs .n-tab-pane) {
  display: flex;
  flex-direction: column;
}

:deep(.sidebar-tabs .n-tabs-tab-wrapper) {
  flex: 1;
  min-width: 0;
}

:deep(.sidebar-tabs .n-tabs-tab) {
  width: 100%;
  justify-content: center;
  padding-block: 13px;
  color: #64748b;
  font-weight: 600;
}

:deep(.sidebar-tabs .n-tabs-tab--active) {
  color: #2563eb;
}

:deep(.sidebar-tabs .n-tabs-bar) {
  height: 2px;
  border-radius: 999px;
  background: #2563eb;
}

.sidebar-section-header {
  border-bottom: 1px solid rgba(226, 232, 240, 0.78);
  background: rgba(248, 250, 252, 0.92);
  color: #64748b;
  letter-spacing: 0.02em;
}

.contact-list {
  padding-bottom: 16px;
}

.contact-item,
.group-item {
  min-height: 60px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  box-shadow: none;
}

.contact-item:hover,
.group-item:hover {
  border-color: transparent;
  background: rgba(226, 232, 240, 0.62);
  box-shadow: none;
}

.contact-item.bg-blue-100 {
  border-color: #dbeafe;
  background: rgba(239, 246, 255, 0.96);
  box-shadow: none;
}

.contact-unread-badge {
  display: inline-flex;
  min-width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border-radius: 9px;
  background: #e11d48;
  color: #fff;
  font-size: 11px;
  line-height: 1;
}

.chat-panel {
  background: #f8fafc;
}

.chat-header {
  z-index: 2;
  border-bottom: 1px solid #e2e8f0;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 1px 0 rgba(15, 23, 42, 0.02);
  backdrop-filter: blur(14px);
}

.message-scrollbar {
  min-height: 0;
  background: #f8fafc;
}

:deep(.message-scrollbar .n-scrollbar-content) {
  padding: 24px;
}

.message-entry {
  position: relative;
  max-width: min(68%, 680px);
}

.message-status {
  color: #64748b;
}

.message-composer-shell {
  flex: none;
  padding: 0;
  border-top: 1px solid #e2e8f0;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 -8px 24px rgba(15, 23, 42, 0.025);
}

.mobile-sidebar-toggle,
.mobile-sidebar-close {
  display: none;
}

.n-tabs.n-tabs--top .n-tab-pane {
  padding-top: 0;
}

@media (max-width: 767px) {
  :deep(.remote-sidebar) {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 20;
    width: min(80vw, 320px) !important;
    min-width: min(80vw, 320px) !important;
    max-width: min(80vw, 320px);
    border-right: 0;
    border-radius: 0 18px 18px 0;
    box-shadow: none;
    transform: translateX(-104%);
    transition: transform 0.24s ease;
  }

  :deep(.remote-sidebar.mobile-open) {
    transform: translateX(0);
  }

  :deep(.remote-sidebar-content) {
    overflow: hidden;
    border-radius: 0 18px 18px 0;
  }

  .sidebar-profile {
    order: 1;
  }
  .sidebar-tabs {
    order: 2;
  }

  .mobile-sidebar-close {
    display: inline-flex;
    order: 3;
    flex: none;
    margin: 10px 12px 12px;
    border-radius: 10px;
  }

  .mobile-sidebar-toggle {
    display: inline-flex;
  }

  .chat-header {
    min-height: 60px;
    padding-inline: 12px;
  }

  :deep(.message-scrollbar .n-scrollbar-content) {
    padding: 16px 12px;
  }

  .message-entry {
    max-width: 88%;
  }

  .message-composer-shell {
    padding-bottom: env(safe-area-inset-bottom);
  }

  .chat-empty-state {
    padding: 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.remote-sidebar) {
    transition: none;
  }
}

.im-page {
  height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: #f1f5f9;
}
.remote-shell {
  max-width: 1152px;
  height: 90dvh;
  border-radius: 16px;
  box-shadow: 0 25px 50px -12px #0004;
}
.sidebar-backdrop {
  position: absolute;
  inset: 0;
  z-index: 15;
  background: #0f172a80;
  backdrop-filter: blur(4px);
  display: none;
}
.sidebar-section-header {
  border: 0;
  color: #94a3b8;
}
:deep(.sidebar-logout) {
  --n-color: transparent !important;
  --n-border: 0 !important;
}
.message-item.items-start:not([data-selecting='true']) {
  padding-left: 44px;
}
.incoming-avatar {
  position: absolute;
  left: 0;
  top: 0;
}
.sidebar-logout .iconfont {
  font-size: var(--icon-size-control);
}
.profile-button {
  --icon-size-control: 16px;
}
.profile-button .iconfont {
  font-size: var(--icon-size-control);
}
.chat-empty-state {
  background: #fff;
  padding: 32px;
}
.empty-icon {
  width: 80px;
  height: 80px;
  display: grid;
  place-items: center;
  color: #2563eb;
  background: #eff6ff;
  border-radius: 24px;
  font-size: 30px;
  margin-bottom: 24px;
  border: 1px solid #dbeafe;
  box-shadow: 0 8px 24px #2563eb0a;
}
.empty-icon .iconfont {
  font-size: 38px;
  line-height: 1;
}
.chat-empty-state h3 {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 8px;
}
.chat-empty-state p {
  max-width: 384px;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.625;
  text-align: center;
  margin-bottom: 24px;
}
.chat-empty-state .n-button {
  height: 40px;
  padding: 0 24px;
  font-size: 12px;
  box-shadow: 0 10px 15px -3px #3b82f633;
}
@media (max-width: 767px) {
  .im-page {
    padding: 0;
  }
  .remote-shell {
    height: 100dvh;
    border-radius: 0;
  }
  .sidebar-backdrop {
    display: block;
  }
  :deep(.remote-sidebar),
  :deep(.remote-sidebar-content) {
    border-radius: 0;
  }
}
</style>
