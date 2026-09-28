<template>
  <div class="h-screen w-full bg-gray-900 flex flex-col">
    <!-- 头部控制栏 -->
    <header class="desktop-call-header min-h-16 bg-gray-800 flex flex-wrap items-center justify-between gap-2 px-3 sm:px-6 py-2 shadow-lg">
      <div class="flex items-center gap-2 sm:gap-4 min-w-0">
        <n-avatar :size="40" :src="groupInfo?.avatar || undefined" class="ring-2 ring-white">
          <span v-if="!groupInfo?.avatar">{{ groupInfo?.name?.charAt(0) }}</span>
        </n-avatar>
        <div class="text-white min-w-0">
          <div class="font-bold truncate">{{ groupInfo?.name }}</div>
          <div class="text-xs text-gray-400">{{ participantUserIds.length }} 人参与通话</div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
        <!-- 麦克风控制 -->
        <n-tooltip>
          <template #trigger>
            <n-button
              circle
              :type="isMicMuted ? 'error' : 'default'"
              @click="toggleMic"
              :disabled="!canSpeak"
            >
              <template #icon>
                <n-icon><i class="iconfont" :class="isMicMuted ? 'icon-microphone-off' : 'icon-microphone'" aria-hidden="true"></i></n-icon>
              </template>
            </n-button>
          </template>
          {{ isMicMuted ? '打开麦克风' : '关闭麦克风' }}
        </n-tooltip>

        <!-- 摄像头控制 -->
        <n-tooltip v-if="!isAudioCall">
          <template #trigger>
            <n-button
              circle
              :type="isCameraOff ? 'error' : 'default'"
              @click="toggleCamera"
            >
              <template #icon>
                <n-icon><i class="iconfont" :class="isCameraOff ? 'icon-video-off' : 'icon-video'" aria-hidden="true"></i></n-icon>
              </template>
            </n-button>
          </template>
          {{ isCameraOff ? '打开摄像头' : '关闭摄像头' }}
        </n-tooltip>

        <!-- 虚拟背景 -->
        <VirtualBackground
          v-if="!isAudioCall"
          :stream="originalLocalStream"
          @stream-updated="handleVirtualBGUpdate"
        />

        <!-- 录制功能 -->
        <MediaRecorder
          v-if="!isAudioCall"
          :stream="localStream"
          @recording-start="handleRecordingStart"
          @recording-stop="handleRecordingStop"
        />

        <!-- 群成员列表；成员控制操作仍仅群主可用 -->
        <n-button circle aria-label="群成员" @click="showMemberControl = true">
          <template #icon>
            <n-icon><i class="iconfont icon-users" aria-hidden="true"></i></n-icon>
          </template>
        </n-button>

        <!-- 退出通话 -->
        <n-button type="error" @click="handleHangup">
          <template #icon>
            <n-icon><i class="iconfont icon-hangup" aria-hidden="true"></i></n-icon>
          </template>
          <span class="hidden sm:inline">退出通话</span>
        </n-button>
      </div>
    </header>

    <!-- 视频区域 -->
    <div class="flex-1 overflow-y-auto p-2 sm:p-4">
      <div class="min-h-full grid gap-2 sm:gap-4 auto-rows-fr" :class="videoGridClass">
        <!-- 本地视频 -->
        <div class="relative bg-gray-800 rounded-lg overflow-hidden shadow-xl">
          <MediaVideo
            :stream="localStream"
            local
            :class="{ 'mirror': !isCameraOff }"
          />
          <div class="absolute bottom-3 left-3 bg-black bg-opacity-60 px-3 py-1 rounded-full">
            <span class="text-white text-sm font-semibold">
              {{ currentUser?.nickname || currentUser?.username }} (我)
              <SpeakingIndicator :stream="localStream" :muted="isMicMuted" />
            </span>
          </div>
          <div v-if="isAudioCall || isCameraOff" class="absolute inset-0 flex items-center justify-center bg-gray-700">
            <n-avatar :size="80" :src="currentUser?.avatar || undefined">
              <span v-if="!currentUser?.avatar">{{ currentUser?.nickname?.charAt(0) || currentUser?.username?.charAt(0) }}</span>
            </n-avatar>
          </div>
          <div v-if="isMicMuted" class="absolute top-3 right-3 bg-red-500 p-2 rounded-full">
            <n-icon :size="16" color="white"><i class="iconfont icon-microphone-off" aria-hidden="true"></i></n-icon>
          </div>
        </div>

        <!-- 远程视频 -->
        <div
          v-for="peer in remotePeers"
          :key="peer.userId"
          class="relative bg-gray-800 rounded-lg overflow-hidden shadow-xl"
        >
          <MediaVideo :stream="peer.stream" />
          <div class="absolute bottom-3 left-3 bg-black bg-opacity-60 px-3 py-1 rounded-full">
            <span class="text-white text-sm font-semibold">
              {{ peer.user?.nickname || peer.user?.username }}
              <SpeakingIndicator :stream="peer.stream" />
            </span>
          </div>
          <div v-if="isAudioCall || peer.isCameraOff" class="absolute inset-0 flex items-center justify-center bg-gray-700">
            <n-avatar :size="80" :src="peer.user?.avatar || undefined">
              <span v-if="!peer.user?.avatar">{{ peer.user?.nickname?.charAt(0) || peer.user?.username?.charAt(0) }}</span>
            </n-avatar>
          </div>
          <div v-if="peer.isMicMuted" class="absolute top-3 right-3 bg-red-500 p-2 rounded-full">
            <n-icon :size="16" color="white"><i class="iconfont icon-microphone-off" aria-hidden="true"></i></n-icon>
          </div>
        </div>
      </div>
    </div>

    <!-- 群成员抽屉 -->
    <n-drawer v-model:show="showMemberControl" width="min(350px, calc(100vw - 24px))" placement="right">
      <n-drawer-content title="群成员">
        <div class="space-y-3">
          <div
            v-for="member in members"
            :key="member.id"
            class="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
          >
            <div class="flex items-center gap-3">
              <n-avatar :size="40" :src="member.avatar || undefined">
                <span v-if="!member.avatar">{{ member.nickname?.charAt(0) || member.username?.charAt(0) }}</span>
              </n-avatar>
              <div>
                <div class="font-semibold">{{ member.nickname || member.username }}
                <SpeakingIndicator :stream="member.id === currentUser?.id ? localStream : peerRegistry.get(member.id)?.stream" :muted="member.id === currentUser?.id && isMicMuted" /></div>
                <div class="text-xs text-gray-500">
                  <n-tag v-if="member.role === 'owner'" type="warning" size="tiny">群主</n-tag>
                  <n-tag v-else-if="member.role === 'admin'" type="info" size="tiny">管理员</n-tag>
                  <n-tag
                    :type="isMemberParticipating(member.id) ? 'success' : 'default'"
                    size="tiny"
                  >
                    {{ isMemberParticipating(member.id) ? '参与中' : '未参与' }}
                  </n-tag>
                </div>
              </div>
            </div>
            <div v-if="member.id !== currentUser?.id && isOwner" class="flex flex-col gap-2">
              <n-switch
                :value="member.canSpeak"
                @update:value="(val: boolean) => handleControlMemberMic(member.socketId || '', val)"
                size="small"
              >
                <template #checked>可发言</template>
                <template #unchecked>禁言</template>
              </n-switch>
            </div>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { mediaOccupancy, type MediaClaim } from '@/services/mediaOccupancy';
import { createRequestId } from '@/utils/requestId';
const mediaOwner = `group-call:${createRequestId()}`;
let mediaClaim: MediaClaim | null = null;
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { getGroupDetail, type GroupMember } from '@/api/group';
import { limitVideoBitrate } from '@/services/mediaBitrate';
import { useAuthStore } from '@/stores/auth';
import { useSocketStore } from '@/stores/socket';
import VirtualBackground from '@/components/VirtualBackground.vue';
import MediaRecorder from '@/components/MediaRecorder.vue';
import MediaVideo from '@/components/MediaVideo.vue';
import SpeakingIndicator from '@/components/SpeakingIndicator.vue';
import {
  createMediaParticipantState,
  type ParticipantSnapshot,
} from '@/services/mediaParticipantState';
import {
  RemotePeerRegistry,
  type RemoteMember,
} from '@/services/remotePeerRegistry';

const route = useRoute();
const router = useRouter();
const isAudioCall = computed(() => route.name === 'GroupAudio');
const sessionType = computed(() => isAudioCall.value ? 'audio' as const : 'video' as const);
const sessionDeviceType = computed(() => isAudioCall.value ? 3 : 1);
const message = useMessage();
const authStore = useAuthStore();
const { currentUser } = storeToRefs(authStore);
const socketStore = useSocketStore();
const { socket, authenticated } = storeToRefs(socketStore);

const groupId = ref(parseInt(route.params.id as string));

const groupInfo = ref<any>(null);
const members = ref<(GroupMember & { socketId?: string; online?: boolean })[]>([]);
const peerRegistry = new RemotePeerRegistry(createPeerConnection);
const participantState = createMediaParticipantState();
const remotePeers = computed(() => peerRegistry.values().map(peer => ({
  ...peer,
  userId: peer.id,
  user: peer,
  isMicMuted: false,
  isCameraOff: false,
})));

const isMicMuted = ref(false);
const isCameraOff = ref(isAudioCall.value);
const showMemberControl = ref(false);
const participantUserIds = computed(() => {
  participantState.version.value;
  return participantState.userIds(groupId.value, sessionType.value);
});

const localStream = ref<MediaStream | null>(null);
const originalLocalStream = ref<MediaStream | null>(null); // 原始流（用于虚拟背景）
let joinedCall = false;
let currentSessionStartedAt: string | null = null;
let cleanedUp = false;
let stopAuthenticatedWatch: (() => void) | null = null;

// 是否是群主
const isOwner = computed(() => {
  const myMember = members.value.find(m => m.id === currentUser.value?.id);
  return myMember?.role === 'owner';
});

// 是否可以发言
const canSpeak = computed(() => {
  const myMember = members.value.find(m => m.id === currentUser.value?.id);
  return myMember?.canSpeak !== false;
});

// 视频网格布局类
const videoGridClass = computed(() => {
  const total = remotePeers.value.length + 1;
  if (total === 1) return 'grid-cols-1';
  if (total === 2) return 'grid-cols-1 sm:grid-cols-2';
  if (total <= 4) return 'grid-cols-1 sm:grid-cols-2';
  if (total <= 6) return 'grid-cols-2 lg:grid-cols-3';
  if (total <= 9) return 'grid-cols-2 lg:grid-cols-3';
  return 'grid-cols-2 lg:grid-cols-4';
});

// 加载群组详情
async function loadGroupDetail() {
  try {
    const detail = await getGroupDetail(groupId.value);
    groupInfo.value = detail.group;
    members.value = detail.members;
  } catch (error: any) {
    message.error('加载群组详情失败: ' + error.message);
    router.back();
  }
}

// 初始化本地媒体流
async function initLocalStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: isAudioCall.value
        ? false
        : { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } },
      audio: true,
    });

    if (cleanedUp || !mediaClaim?.isCurrent()) { stream.getTracks().forEach(track => track.stop()); return; }
    originalLocalStream.value = stream; // 保存原始流
    localStream.value = stream; // 当前流（可能被虚拟背景处理）
  } catch (error: any) {
    message.error('获取媒体设备失败: ' + error.message);
  }
}

// 虚拟背景流更新
function handleVirtualBGUpdate(processedStream: MediaStream) {
  localStream.value = processedStream;

  const nextVideoTrack = processedStream.getVideoTracks()[0];
  if (nextVideoTrack) {
    remotePeers.value.forEach(peer => {
      const connection = peer.connection as RTCPeerConnection;
      const sender = connection.getSenders()
        .find((item: RTCRtpSender) => item.track?.kind === 'video');
      void sender?.replaceTrack(nextVideoTrack);
    });
  }
  if (nextVideoTrack) nextVideoTrack.enabled = !isCameraOff.value;
  message.success('虚拟背景已应用');
  // 可以在这里更新发送给其他对等端的流
}

// 录制功能回调
function handleRecordingStart() {
  message.success('开始录制视频通话');
}

function handleRecordingStop(blob: Blob) {
  message.success(`录制完成，文件大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  // 可以在这里上传到服务器
}

// 初始化Socket连接
function initSocket() {
  socketStore.joinGroup(groupId.value);
  const target = socket.value;
  if (!target) return;

  stopAuthenticatedWatch = watch(
    authenticated,
    ready => {
      if (!ready) return;
      socket.value?.emit('group_call_start', {
        groupId: groupId.value,
        deviceType: sessionDeviceType.value,
      });
    },
    { immediate: true },
  );

  // 接收群组成员列表
  target.on('group_call_state', handleCallState);
  target.on('group_call_members', handleCallMembers);

  // 新成员加入
  target.on('group_call_member_joined', handleCallMemberJoined);
  target.on('group_call_member_left', handleCallMemberLeft);
  target.on('group_call_presence', handleCallPresence);
  target.on('group_call_ended', handleCallEnded);
  target.on('group_access_revoked', handleGroupAccessRevoked);
  target.on('group_call_error', handleGroupCallError);
  target.on('disconnect', handleSocketDisconnect);

  // WebRTC 信令
  target.on('group_webrtc_offer', handleOffer);
  target.on('group_webrtc_answer', handleAnswer);
  target.on('group_webrtc_ice', handleIceCandidate);

  // 麦克风权限变化
  target.on('mic_permission_changed', handleMicPermissionChanged);

  // 成员麦克风状态变化
  target.on('member_mic_changed', handleMemberMicChanged);
}

// 创建对等连接
function createPeerConnection(member: RemoteMember) {
  const startedAt = currentSessionStartedAt;
  const pc = new RTCPeerConnection({
    iceServers: [
      {
        urls: 'stun:turn.sycsq.top:3478'
      },
      {
        urls: [
          'turn:turn.sycsq.top:3478?transport=udp',
          'turn:turn.sycsq.top:3478?transport=tcp'
        ],
        username: 'todesk',
        credential: 'BOcYoq/Q4QEZTzhod7JmJ51S1gqSkVMe'
      }
    ],
  });

  // 添加本地流
  localStream.value?.getTracks().forEach(track => {
    const sender = pc.addTrack(track, localStream.value!);
    if (track.kind === 'video') void limitVideoBitrate(sender, 900_000);
  });

  // 处理远程流
  pc.ontrack = (event) => {
    if (event.streams[0]) peerRegistry.setStream(member.id, event.streams[0]);
  };

  // ICE 候选
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.value?.emit('group_webrtc_ice', {
        startedAt,
        to: member.socketId,
        candidate: event.candidate,
        groupId: groupId.value,
        deviceType: sessionDeviceType.value,
      });
    }
  };
  return pc;
}

async function createAndSendOffer(member: RemoteMember) {
  const startedAt = currentSessionStartedAt;
  const peer = peerRegistry.upsert(member);
  const pc = peer.connection as RTCPeerConnection;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.value?.emit('group_webrtc_offer', {
    startedAt,
    to: member.socketId,
    offer,
    deviceType: sessionDeviceType.value,
    groupId: groupId.value,
  });
}

// 处理 offer
async function handleOffer(data: any) {
  if (!currentSessionStartedAt || data.startedAt !== currentSessionStartedAt || cleanedUp) return;
  if (data.groupId !== groupId.value || data.deviceType !== sessionDeviceType.value || !data.fromUser) return;
  // 如果连接不存在，创建新的
  const peer = peerRegistry.upsert({ ...data.fromUser, socketId: data.from });
  const pc = peer.connection as RTCPeerConnection;
  await pc.setRemoteDescription(data.offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.value?.emit('group_webrtc_answer', {
    startedAt: data.startedAt,
    to: data.from,
    answer,
    deviceType: sessionDeviceType.value,
    groupId: groupId.value,
  });
}

// 处理 answer
async function handleAnswer(data: any) {
  if (!currentSessionStartedAt || data.startedAt !== currentSessionStartedAt || cleanedUp) return;
  if (data.groupId !== groupId.value || data.deviceType !== sessionDeviceType.value) return;
  const pc = findPeerBySocket(data.from)?.connection as RTCPeerConnection | undefined;
  if (pc) {
    await pc.setRemoteDescription(data.answer);
  }
}

// 处理 ICE 候选
async function handleIceCandidate(data: any) {
  if (!currentSessionStartedAt || data.startedAt !== currentSessionStartedAt || cleanedUp) return;
  if (data.groupId !== groupId.value || data.deviceType !== sessionDeviceType.value) return;
  const pc = findPeerBySocket(data.from)?.connection as RTCPeerConnection | undefined;
  if (pc) {
    await pc.addIceCandidate(data.candidate);
  }
}

function findPeerBySocket(socketId: string) {
  return peerRegistry.values().find(peer => peer.socketId === socketId);
}

function handleCallState(data: any) {
  const session = data.sessions[sessionType.value];
  if (data.groupId !== groupId.value || !session || joinedCall) return;
  participantState.setChannel(
    groupId.value,
    sessionType.value,
    session.channelId,
  );
  joinedCall = true;
  currentSessionStartedAt = session.startedAt;
  socket.value?.emit('join_group_call', { groupId: groupId.value, deviceType: sessionDeviceType.value, startedAt: session.startedAt });
}

function handleCallMembers(data: any) {
  if (cleanedUp || data.startedAt !== currentSessionStartedAt) return;
  if (data.groupId !== groupId.value || data.type !== sessionType.value) return;
  data.members.forEach((member: RemoteMember) => {
    if (member.id !== currentUser.value?.id) {
      peerRegistry.upsert(member);
      mergeMemberSocket(member);
    }
  });
}

async function handleCallMemberJoined(data: any) {
  if (cleanedUp || data.startedAt !== currentSessionStartedAt) return;
  if (data.groupId !== groupId.value || data.type !== sessionType.value) return;
  if (data.member.id === currentUser.value?.id) return;
  mergeMemberSocket(data.member);
  // 只有房间中的现有成员向新成员发 offer，避免双方同时协商。
  await createAndSendOffer(data.member);
}

function handleCallMemberLeft(data: any) {
  if (cleanedUp || data.startedAt !== currentSessionStartedAt) return;
  if (data.groupId !== groupId.value || data.type !== sessionType.value || !data.userId) return;
  peerRegistry.remove(data.userId, data.socketId);
}

function handleCallPresence(data: ParticipantSnapshot) {
  if (data.groupId !== groupId.value || data.type !== sessionType.value) return;
  participantState.apply(data);
}

function handleCallEnded(data: any) {
  if (cleanedUp || (data.startedAt && data.startedAt !== currentSessionStartedAt)) return;
  if (data.groupId !== groupId.value || data.deviceType !== sessionDeviceType.value) return;
  joinedCall = false;
  currentSessionStartedAt = null;
  peerRegistry.clear();
  localStream.value?.getTracks().forEach(track => track.stop());
  originalLocalStream.value?.getTracks().forEach(track => track.stop());
  participantState.clear(groupId.value, sessionType.value);
}

function handleGroupAccessRevoked(data: { groupId: number }) {
  if (data.groupId !== groupId.value) return;
  cleanupCall(false);
  message.warning('群组访问权限已失效，通话已停止');
  void router.replace('/groups');
}
function handleGroupCallError(data: { groupId: number; message?: string }) {
  if (data.groupId !== groupId.value || cleanedUp) return;
  cleanupCall(false);
  message.error(data.message || '无法加入群组通话');
  void router.replace('/groups');
}

function handleSocketDisconnect() {
  cleanupCall(false);
  message.warning('连接已断开，通话已停止');
  void router.replace('/groups');
}

function isMemberParticipating(userId: number) {
  participantState.version.value;
  return participantState.isParticipating(groupId.value, sessionType.value, userId);
}

function mergeMemberSocket(member: RemoteMember) {
  const groupMember = members.value.find(item => item.id === member.id);
  if (groupMember) groupMember.socketId = member.socketId;
}

function handleMemberMicChanged(data: any) {
  const peer = findPeerBySocket(data.socketId);
  if (peer) {
    const viewPeer = remotePeers.value.find(item => item.id === peer.id);
    if (viewPeer) viewPeer.isMicMuted = data.muted;
  }
}

function handleMicPermissionChanged(data: any) {
  if (data.groupId !== groupId.value) return;
  if (!data.canSpeak) {
    isMicMuted.value = true;
    localStream.value?.getAudioTracks().forEach(track => { track.enabled = false; });
    message.warning('您已被群主禁言');
  } else {
    message.success('您已被允许发言');
  }
}

// 切换麦克风
function toggleMic() {
  if (!canSpeak.value) {
    message.warning('您已被禁言');
    return;
  }

  isMicMuted.value = !isMicMuted.value;
  localStream.value?.getAudioTracks().forEach(track => {
    track.enabled = !isMicMuted.value;
  });

  socket.value?.emit('toggle_mic', {
    groupId: groupId.value,
    muted: isMicMuted.value,
  });
}

// 切换摄像头
function toggleCamera() {
  isCameraOff.value = !isCameraOff.value;
  localStream.value?.getVideoTracks().forEach(track => {
    track.enabled = !isCameraOff.value;
  });
}

// 控制成员麦克风
function handleControlMemberMic(socketId: string, canSpeak: boolean) {
  socket.value?.emit('control_member_mic', {
    groupId: groupId.value,
    targetSocketId: socketId,
    canSpeak,
  });

  // 更新本地数据
  const member = members.value.find(m => m.socketId === socketId);
  if (member) {
    member.canSpeak = canSpeak;
  }
}

// 挂断
function handleHangup() {
  cleanupCall(true);
  router.back();
}

function cleanupCall(endOwnedSession: boolean) {
  if (cleanedUp) return;
  cleanedUp = true;
  currentSessionStartedAt = null;
  const ownedMedia = !!mediaClaim;
  mediaClaim?.release();
  mediaClaim = null;
  if (!ownedMedia) return;

  // 停止本地流
  localStream.value?.getTracks().forEach(track => track.stop());
  if (originalLocalStream.value !== localStream.value) {
    originalLocalStream.value?.getTracks().forEach(track => track.stop());
  }

  // 关闭所有对等连接
  peerRegistry.clear();
  participantState.clear(groupId.value, sessionType.value);

  // 通知服务器
  // 服务端会校验会话所有者；即使“开始”仍在异步创建中，也要发送结束事件以取消待广播的邀请。
  if (endOwnedSession) {
    socket.value?.emit('group_call_end', { groupId: groupId.value, deviceType: sessionDeviceType.value });
  }
  socket.value?.emit('leave_group_call', { groupId: groupId.value, deviceType: sessionDeviceType.value });
  stopAuthenticatedWatch?.();
  stopAuthenticatedWatch = null;
  unbindSocketEvents();
  socketStore.leaveGroup(groupId.value);
}

function unbindSocketEvents() {
  socket.value?.off('group_call_state', handleCallState);
  socket.value?.off('group_call_members', handleCallMembers);
  socket.value?.off('group_call_member_joined', handleCallMemberJoined);
  socket.value?.off('group_call_member_left', handleCallMemberLeft);
  socket.value?.off('group_call_presence', handleCallPresence);
  socket.value?.off('group_call_ended', handleCallEnded);
  socket.value?.off('group_access_revoked', handleGroupAccessRevoked);
  socket.value?.off('group_call_error', handleGroupCallError);
  socket.value?.off('disconnect', handleSocketDisconnect);
  socket.value?.off('group_webrtc_offer', handleOffer);
  socket.value?.off('group_webrtc_answer', handleAnswer);
  socket.value?.off('group_webrtc_ice', handleIceCandidate);
  socket.value?.off('mic_permission_changed', handleMicPermissionChanged);
  socket.value?.off('member_mic_changed', handleMemberMicChanged);
}

onMounted(async () => {
  mediaClaim = mediaOccupancy.acquire('group-call', mediaOwner, () => cleanupCall(true));
  if (!mediaClaim) { message.warning('请先结束当前通话或远程控制'); await router.replace(`/group-chat/${groupId.value}`); return; }
  await loadGroupDetail();
  if (cleanedUp || !mediaClaim?.isCurrent()) return;
  await initLocalStream();
  if (cleanedUp || !mediaClaim?.isCurrent()) return;
  initSocket();
});

onUnmounted(() => {
  cleanupCall(true);
});
</script>

<style scoped>
.mirror {
  transform: scaleX(-1);
}
</style>
