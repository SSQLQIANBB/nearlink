<template>
  <div class="group-im-page">
    <n-layout
      has-sider
      class="group-im-shell"
    >
      <button
        v-if="mobileSidebarOpen"
        class="group-sidebar-backdrop"
        aria-label="收起群成员侧栏"
        @click="mobileSidebarOpen = false"
      ></button>
      <!-- 侧边栏 -->
      <n-layout-sider
        class="group-chat-sider"
        :class="{ 'mobile-open': mobileSidebarOpen }"
        bordered
        :width="320"
        :collapsed-width="0"
        collapse-mode="transform"
        :show-trigger="false"
        content-class="flex flex-col bg-white shadow-lg"
      >
        <n-button
          class="mobile-sidebar-close"
          secondary
          @click="mobileSidebarOpen = false"
        >
          关闭成员列表
        </n-button>
        <!-- 群组信息卡片 -->
        <div
          class="group-sidebar-profile p-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white"
        >
          <div class="flex items-center gap-3">
            <n-avatar
              :size="50"
              :src="groupInfo?.avatar || undefined"
            >
              <span v-if="!groupInfo?.avatar">{{ groupInfo?.name?.charAt(0) || '?' }}</span>
              <template #fallback>
                <span class="flex h-full w-full items-center justify-center">
                  {{ groupInfo?.name?.charAt(0) || '?' }}
                </span>
              </template>
            </n-avatar>
            <div class="flex-1">
              <div class="font-bold text-base">{{ groupInfo?.name || '加载中...' }}</div>
              <div class="text-xs opacity-90 mt-1">{{ onlineCount }} 成员在线</div>
            </div>
          </div>
        </div>

        <!-- 成员列表 -->
        <div class="px-4 py-3 text-xs text-gray-500 font-semibold border-b bg-gray-50">
          群组成员 ({{ members.length }})
        </div>
        <ul class="flex-1 p-3 overflow-y-auto space-y-2">
          <li
            v-for="member in members"
            :key="member.id"
            class="flex items-center gap-3 p-3 rounded-lg bg-white border border-gray-200"
          >
            <n-avatar
              :size="40"
              :src="member.avatar || undefined"
            >
              <span v-if="!member.avatar">
                {{ member.nickname?.charAt(0) || member.username?.charAt(0) }}
              </span>
              <template #fallback>
                <span class="flex h-full w-full items-center justify-center">
                  {{ member.nickname?.charAt(0) || member.username?.charAt(0) }}
                </span>
              </template>
            </n-avatar>
            <div class="flex-1">
              <div class="font-semibold text-sm">{{ member.nickname || member.username }}</div>
              <div class="flex items-center gap-2 text-xs text-gray-500 mt-1">
                <n-tag
                  v-if="member.role === 'owner'"
                  type="warning"
                  size="tiny"
                >
                  群主
                </n-tag>
                <n-tag
                  v-else-if="member.role === 'admin'"
                  type="info"
                  size="tiny"
                >
                  管理员
                </n-tag>
                <span
                  v-if="member.canSpeak === false"
                  class="member-muted text-red-500"
                >
                  <i
                    class="iconfont icon-microphone-off"
                    aria-hidden="true"
                  ></i>
                  禁言
                </span>
              </div>
            </div>
            <div
              class="w-2 h-2 rounded-full"
              :class="member.online ? 'bg-green-400' : 'bg-gray-300'"
            ></div>
          </li>

          <n-empty
            v-if="members.length === 0"
            class="h-full flex items-center justify-center"
            description="暂无成员"
            size="small"
          />
        </ul>

        <!-- 底部操作栏 -->
        <div class="p-3 border-t bg-gray-50 space-y-2">
          <n-button
            block
            secondary
            @click="handleVideoCall"
          >
            <template #icon>
              <i
                class="iconfont call-action-icon icon-video"
                aria-hidden="true"
              ></i>
            </template>
            {{ groupSessionState.getButtonLabel(groupId, 'video') }}
          </n-button>
          <n-button
            block
            secondary
            @click="handleAudioCall"
          >
            <template #icon>
              <i
                class="iconfont call-action-icon icon-dianhua"
                aria-hidden="true"
              ></i>
            </template>
            {{ groupSessionState.getButtonLabel(groupId, 'audio') }}
          </n-button>
          <n-button
            block
            secondary
            @click="handleScreenShare"
          >
            <template #icon>
              <i
                class="iconfont call-action-icon icon-gongxiangpingmu"
                aria-hidden="true"
              ></i>
            </template>
            {{ groupSessionState.getButtonLabel(groupId, 'screen') }}
          </n-button>
          <n-button
            block
            secondary
            @click="goBack"
          >
            <template #icon>
              <i
                class="iconfont group-action-icon icon-arrow-left"
                aria-hidden="true"
              ></i>
            </template>
            返回
          </n-button>
        </div>
      </n-layout-sider>

      <!-- 主聊天区 -->
      <n-layout-content content-class="w-full flex flex-col">
        <div class="h-full w-full flex flex-col bg-white">
          <!-- 聊天头部 -->
          <header
            class="min-h-16 shadow-sm flex items-center gap-2 px-3 sm:px-6 py-2 bg-gradient-to-r from-white to-gray-50 border-b"
          >
            <n-button
              class="mobile-sidebar-toggle"
              secondary
              aria-label="打开群成员列表"
              @click="mobileSidebarOpen = true"
            >
              <i
                class="iconfont icon-bars"
                aria-hidden="true"
              ></i>
            </n-button>
            <div class="flex items-center gap-3 flex-1 min-w-0">
              <n-avatar
                :size="40"
                :src="groupInfo?.avatar || undefined"
              >
                <span v-if="!groupInfo?.avatar">{{ groupInfo?.name?.charAt(0) }}</span>
                <template #fallback>
                  <span class="flex h-full w-full items-center justify-center">
                    {{ groupInfo?.name?.charAt(0) }}
                  </span>
                </template>
              </n-avatar>
              <div class="min-w-0">
                <div class="font-bold text-base truncate">{{ groupInfo?.name }}</div>
                <div class="text-xs text-gray-500 truncate">
                  {{ groupInfo?.description || '暂无简介' }}
                </div>
              </div>
            </div>
            <n-button
              secondary
              @click="showGroupDetail = true"
            >
              <template #icon>
                <i
                  class="iconfont group-action-icon icon-info"
                  aria-hidden="true"
                ></i>
              </template>
              群组详情
            </n-button>
          </header>

          <!-- 消息列表 -->
          <n-scrollbar
            class="flex-1 p-4"
            ref="scrollbarRef"
          >
            <ul class="space-y-4">
              <li
                v-for="(msg, index) in messages"
                :key="index"
                class="flex flex-col"
                :class="msg.isMine ? 'items-end' : 'items-start'"
              >
                <div
                  class="group-message-row flex items-start gap-2 max-w-[88%] sm:max-w-[70%]"
                  :title="msg.time"
                >
                  <n-avatar
                    v-if="!msg.isMine"
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
                    <ChatMessageContent
                      class="group-message-bubble"
                      :message="msg.message"
                      :message-type="msg.messageType"
                      :media="msg.media"
                      :call="msg.call"
                      :is-mine="msg.isMine"
                    />
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

              <n-empty
                v-if="messages.length === 0"
                class="py-20"
                description="暂无消息，开始聊天吧"
                size="large"
              />
            </ul>
          </n-scrollbar>

          <!-- 输入框 -->
          <footer class="group-chat-composer p-4 border-t bg-white">
            <ChatMediaComposer
              compact
              :disabled="!canSpeak"
              :group-id="groupId"
              @send="sendGroupMedia"
            >
              <TextMsg
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
        </div>
      </n-layout-content>

      <!-- 群组详情抽屉 -->
      <n-drawer
        v-model:show="showGroupDetail"
        width="min(400px, calc(100vw - 24px))"
        placement="right"
      >
        <n-drawer-content title="群组详情">
          <n-spin :show="detailLoading">
            <div class="space-y-4">
              <!-- 群组信息 -->
              <div class="text-center">
                <n-avatar
                  :size="80"
                  :src="groupInfo?.avatar || undefined"
                >
                  <span v-if="!groupInfo?.avatar">{{ groupInfo?.name?.charAt(0) }}</span>
                  <template #fallback>
                    <span class="flex h-full w-full items-center justify-center">
                      {{ groupInfo?.name?.charAt(0) }}
                    </span>
                  </template>
                </n-avatar>
                <h3 class="text-xl font-bold mt-3">{{ groupInfo?.name }}</h3>
                <p class="text-sm text-gray-500 mt-1">{{ groupInfo?.description }}</p>
              </div>

              <n-divider />

              <!-- 群组统计 -->
              <div class="grid grid-cols-2 gap-4 text-center">
                <div class="p-3 bg-blue-50 rounded-lg">
                  <div class="text-2xl font-bold text-blue-600">{{ members.length }}</div>
                  <div class="text-xs text-gray-500 mt-1">群组成员</div>
                </div>
                <div class="p-3 bg-green-50 rounded-lg">
                  <div class="text-2xl font-bold text-green-600">{{ onlineCount }}</div>
                  <div class="text-xs text-gray-500 mt-1">在线成员</div>
                </div>
              </div>

              <n-divider />

              <!-- 快捷操作 -->
              <div class="space-y-2">
                <n-button
                  block
                  secondary
                  @click="handleVideoCall"
                >
                  <template #icon>
                    <i
                      class="iconfont call-action-icon icon-video"
                      aria-hidden="true"
                    ></i>
                  </template>
                  {{ groupSessionState.getButtonLabel(groupId, 'video') }}
                </n-button>
                <n-button
                  block
                  secondary
                  @click="handleAudioCall"
                >
                  <template #icon>
                    <i
                      class="iconfont call-action-icon icon-dianhua"
                      aria-hidden="true"
                    ></i>
                  </template>
                  {{ groupSessionState.getButtonLabel(groupId, 'audio') }}
                </n-button>
                <n-button
                  block
                  secondary
                  @click="handleScreenShare"
                >
                  <template #icon>
                    <i
                      class="iconfont call-action-icon icon-gongxiangpingmu"
                      aria-hidden="true"
                    ></i>
                  </template>
                  {{ groupSessionState.getButtonLabel(groupId, 'screen') }}
                </n-button>
              </div>
            </div>
          </n-spin>
        </n-drawer-content>
      </n-drawer>
    </n-layout>
  </div>
</template>

<script setup lang="ts">
import { isAppInBackground } from '@/services/appVisibility';
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage, type ScrollbarInst } from 'naive-ui';
import { getGroupDetail, type GroupMember } from '@/api/group';
import { useAuthStore } from '@/stores/auth';
import { storeToRefs } from 'pinia';
import { useSocketStore } from '@/stores/socket';
import { useUnreadStore } from '@/stores/unread';
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { captureGroupScreen, discardCapturedGroupScreen } from '@/services/screenShareLaunch';
import { getGroupMessages, type ChatMediaPayload } from '@/api/message';
import { sendReliableMessage } from '@/services/reliableMessage';
import { applyMessageAck } from '@/services/messageDeliveryState';
import { groupSessionState } from '@/services/groupSessionState';
import TextMsg from '@/components/TextMsg.vue';
import ChatMediaComposer from '@/components/ChatMediaComposer.vue';
import ChatMessageContent from '@/components/ChatMessageContent.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const authStore = useAuthStore();
const { currentUser } = storeToRefs(authStore);
const socketStore = useSocketStore();
const unread = useUnreadStore();
const { socket } = storeToRefs(socketStore);

const mobileSidebarOpen = ref(false);
const groupId = ref(parseInt(route.params.id as string));
const scrollbarRef = ref<ScrollbarInst | null>(null);

const detailLoading = ref(false);
const showGroupDetail = ref(false);

const groupInfo = ref<any>(null);
const members = ref<(GroupMember & { online?: boolean })[]>([]);
const messages = ref<any[]>([]);

// 当前用户是否可以发言
const canSpeak = computed(() => {
  const myMember = members.value.find((m) => m.id === currentUser.value?.id);
  return myMember?.canSpeak !== false;
});

// 在线成员数量
const onlineCount = computed(() => {
  return members.value.filter((m) => m.online).length;
});

// 加载群组详情
async function loadGroupDetail() {
  try {
    detailLoading.value = true;
    const detail = await getGroupDetail(groupId.value);
    groupInfo.value = detail.group;
    const onlineIds = new Set(socketStore.userList.map((user) => user.id));
    if (socketStore.authenticated && currentUser.value) onlineIds.add(currentUser.value.id);
    members.value = detail.members.map((m) => ({ ...m, online: onlineIds.has(m.id) }));
  } catch (error: any) {
    message.error('加载群组详情失败: ' + error.message);
    router.back();
  } finally {
    detailLoading.value = false;
  }
}

// 初始化Socket连接
async function loadGroupHistory() {
  try {
    const res = await getGroupMessages(groupId.value);
    messages.value = res.messages.map((msg) => ({
      message: msg.message,
      time: new Date(msg.createdAt).toLocaleString(),
      user: msg.sender,
      isMine: msg.userId === currentUser.value?.id,
      messageType: msg.messageType,
      call: msg.call,
      media: msg.media,
    }));
    scrollToBottom('auto');
  } catch (error: any) {
    message.error('加载群聊记录失败: ' + error.message);
  }
}

function initSocket() {
  socketStore.joinGroup(groupId.value);
  socket.value?.on('group_members', handleGroupMembers);
  socket.value?.on('group_member_joined', handleGroupMemberJoined);
  socket.value?.on('group_member_left', handleGroupMemberLeft);
  socket.value?.on('group_message', handleGroupMessage);
}

function handleGroupMembers(data: { groupId: number; members: any[] }) {
  if (data.groupId !== groupId.value) return;

  data.members.forEach((socketMember) => {
    const member = members.value.find((item) => item.id === socketMember.id);
    if (member) member.online = true;
  });
}

function handleGroupMemberJoined(data: { groupId: number; member: any }) {
  if (data.groupId !== groupId.value) return;

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
  if (data.groupId !== groupId.value) return;
  if (data.id && messages.value.some((msg) => msg.id === data.id)) return;

  messages.value.push({
    id: data.id,
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
  if (!canSpeak.value) {
    message.warning('您已被禁言');
    return;
  }

  const msg = {
    clientMessageId: crypto.randomUUID(),
    message: text,
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
  if (!canSpeak.value) {
    message.warning('您已被禁言');
    return;
  }
  const msg = {
    clientMessageId: crypto.randomUUID(),
    message: payload.type === 'image' ? '[图片]' : `[语音] ${payload.media.durationSeconds}秒`,
    messageType: payload.type,
    media: payload.media,
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
  nextTick(() => {
    scrollbarRef.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior });
  });
}

// 发起视频通话
function handleVideoCall() {
  if (mediaOccupancy.current.value) {
    message.warning('请先结束当前通话或远程控制');
    return;
  }
  void router.push(`/group-video/${groupId.value}`);
}

function handleAudioCall() {
  if (mediaOccupancy.current.value) {
    message.warning('请先结束当前通话或远程控制');
    return;
  }
  void router.push(`/group-audio/${groupId.value}`);
}

// 发起屏幕共享
async function handleScreenShare() {
  if (mediaOccupancy.current.value) {
    message.warning('请先结束当前通话或远程控制');
    return;
  }
  if (groupSessionState.getSession(groupId.value, 'screen')) {
    await router.push(`/group-screen/${groupId.value}`);
    return;
  }
  try {
    await captureGroupScreen(groupId.value);
    if (socketStore.authenticated)
      socket.value?.emit('group_call_start', { groupId: groupId.value, deviceType: 2 });
    await router.push(`/group-screen/${groupId.value}`);
  } catch (error: any) {
    discardCapturedGroupScreen(groupId.value);
    if (error?.name !== 'NotAllowedError') message.error('无法开始屏幕共享: ' + error.message);
  }
}

// 返回
function goBack() {
  router.back();
}

async function retryGroupMessage(msg: any) {
  if (!msg.clientMessageId) return;
  msg.sendStatus = 'pending';
  const result = await sendReliableMessage(socket.value, 'group_message', {
    groupId: groupId.value,
    message: msg.message,
    messageType: msg.messageType,
    media: msg.media,
    clientMessageId: msg.clientMessageId,
  });
  messages.value = applyMessageAck(messages.value, msg.clientMessageId, result);
}

function clearVisibleUnread() {
  if (!isAppInBackground()) unread.readGroup(groupId.value);
}

onMounted(async () => {
  clearVisibleUnread();
  document.addEventListener('visibilitychange', clearVisibleUnread);
  window.addEventListener('focus', clearVisibleUnread);
  await loadGroupDetail();
  await loadGroupHistory();
  initSocket();
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', clearVisibleUnread);
  window.removeEventListener('focus', clearVisibleUnread);
  socket.value?.off('group_members', handleGroupMembers);
  socket.value?.off('group_member_joined', handleGroupMemberJoined);
  socket.value?.off('group_member_left', handleGroupMemberLeft);
  socket.value?.off('group_message', handleGroupMessage);
  socketStore.leaveGroup(groupId.value);
});
</script>

<style scoped>
.member-muted {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.member-muted .iconfont {
  font-size: var(--icon-size-inline);
}
.mobile-sidebar-toggle .iconfont {
  font-size: var(--icon-size-control);
}
.group-action-icon {
  font-size: 16px;
}
.mobile-sidebar-toggle {
  display: none;
}
.mobile-sidebar-close {
  display: none;
}
@media (max-width: 767px) {
  .mobile-sidebar-toggle,
  .mobile-sidebar-close {
    display: inline-flex;
  }
}
@media (max-width: 767px) {
  :deep(.group-chat-sider) {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 20;
    max-width: calc(100vw - 44px);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  :deep(.group-chat-sider.mobile-open) {
    transform: translateX(0);
  }
}

.group-im-page {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100dvh;
  padding: 16px;
  background: #f1f5f9;
}
.group-im-shell {
  width: 100%;
  max-width: 1152px;
  height: 90dvh;
  border-radius: 16px;
  box-shadow: 0 25px 50px -12px #0004;
}
.group-im-shell :deep(.n-layout-sider-scroll-container) {
  background: #f8fafc;
}
.group-im-shell :deep(.n-layout-content),
.group-im-shell :deep(.n-layout-content > .n-layout-scroll-container > div) {
  background: #f8fafc;
}
.group-im-shell header {
  box-shadow: none;
  background: #fff;
}
.group-im-shell header .font-bold {
  font-size: 14px;
}
.group-im-shell ul > li {
  border: 0;
  background: transparent;
}
.group-chat-composer :deep(.chat-media-composer) {
  padding: 4px 0;
}
.group-sidebar-backdrop {
  display: none;
  position: absolute;
  inset: 0;
  background: #0f172a80;
  backdrop-filter: blur(4px);
  z-index: 15;
}
.group-im-shell :deep(.group-chat-sider .n-layout-sider-scroll-container) {
  display: flex;
  flex-direction: column;
}
.group-im-shell .mobile-sidebar-close {
  order: 5;
}
@media (max-width: 767px) {
  .group-im-page {
    padding: 0;
  }
  .group-im-shell {
    height: 100dvh;
    border-radius: 0;
  }
  .group-sidebar-backdrop {
    display: block;
  }
}
</style>
