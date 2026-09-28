<template>
  <div class="h-screen w-full bg-gray-900 flex flex-col">
    <!-- 头部控制栏 -->
    <header class="desktop-call-header min-h-16 bg-gray-800 flex flex-wrap items-center justify-between gap-2 px-3 sm:px-6 py-2 shadow-lg">
      <div class="flex items-center gap-2 sm:gap-4 min-w-0">
        <n-avatar :size="40" :src="groupInfo?.avatar || undefined" class="ring-2 ring-white">
          <span v-if="!groupInfo?.avatar">{{ groupInfo?.name?.charAt(0) }}</span>
        </n-avatar>
        <div class="text-white min-w-0">
          <div class="font-bold truncate">{{ groupInfo?.name }} - 屏幕共享</div>
          <div class="text-xs text-gray-400">
            {{ isSharing ? '正在共享屏幕' : '观看屏幕共享' }} · {{ participantUserIds.length }} 人参与
          </div>
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

        <!-- 标注工具 -->
        <n-tooltip v-if="isSharing">
          <template #trigger>
            <n-button
              circle
              :aria-label="showAnnotation ? '关闭标注' : '开启标注'"
              :type="showAnnotation ? 'primary' : 'default'"
              @click="showAnnotation = !showAnnotation"
            >
              <template #icon>
                <n-icon>
                  <i class="iconfont icon-pen" aria-hidden="true"></i>
                </n-icon>
              </template>
            </n-button>
          </template>
          {{ showAnnotation ? '关闭标注' : '开启标注' }}
        </n-tooltip>

        <!-- 录制功能 -->
        <MediaRecorder
          v-if="isSharing || sharer"
          :stream="screenStream"
          @recording-start="handleRecordingStart"
          @recording-stop="handleRecordingStop"
        />

        <!-- 视频质量设置 -->
        <n-dropdown :options="qualityOptions" @select="handleQualityChange">
          <n-button circle>
            <template #icon>
              <n-icon><i class="iconfont icon-tune" aria-hidden="true"></i></n-icon>
            </template>
          </n-button>
        </n-dropdown>

        <!-- 群成员列表；麦克风控制仍仅群主可用 -->
        <n-button circle aria-label="群成员" @click="showMemberControl = true">
          <template #icon>
            <n-icon><i class="iconfont icon-users" aria-hidden="true"></i></n-icon>
          </template>
        </n-button>

        <!-- 开始/停止共享 -->
        <n-button v-if="!isSharing && !sharer" type="primary" @click="startScreenShare">
          <template #icon>
            <n-icon><i class="iconfont icon-screen-share" aria-hidden="true"></i></n-icon>
          </template>
          开始共享
        </n-button>
        <n-button v-if="isSharing" type="warning" @click="stopScreenShare">
          <template #icon>
            <n-icon><i class="iconfont icon-screen-stop" aria-hidden="true"></i></n-icon>
          </template>
          停止共享
        </n-button>

        <!-- 退出 -->
        <n-button type="error" @click="handleExit">
          <template #icon>
            <n-icon><i class="iconfont icon-hangup" aria-hidden="true"></i></n-icon>
          </template>
          <span class="hidden sm:inline">退出</span>
        </n-button>
      </div>
    </header>

    <!-- 其他成员的音频；共享者音频由主视频播放，避免重复。 -->
    <MediaVideo v-for="peer in peerRegistry.values().filter(item => item.id !== sharer?.id)" :key="peer.id" :stream="peer.stream" style="display: none" />
    <!-- 主内容区 -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 屏幕共享主区域 -->
      <div class="flex-1 min-w-0 p-2 sm:p-4 flex items-center justify-center">
        <div ref="screenViewport" class="relative w-full h-full bg-gray-800 rounded-lg overflow-hidden shadow-2xl">
          <!-- 共享屏幕视频 -->
          <MediaVideo
            v-if="isSharing || sharer"
            :stream="displayStream"
            :local="isSharing"
            style="object-fit: contain"
            @loadedmetadata="updateVideoDimensions"
            @resize="updateVideoDimensions"
          />

          <!-- 标注层：共享者可编辑，其他参与者只读 -->
          <ScreenAnnotation
            v-if="isSharing || (screenSession && (annotationActions.length || annotationDrafts.length))"
            :style="annotationBounds"
            :actions="annotationActions"
            :drafts="annotationDrafts"
            :editable="isSharing && showAnnotation"
            :show-toolbar="isSharing && showAnnotation"
            @draft="sendAnnotationDraft"
            @complete="sendAnnotationComplete"
            @undo="sendAnnotationUndo"
            @clear="sendAnnotationClear"
            @close="showAnnotation = false"
          />

          <!-- 无共享提示 -->
          <div v-if="!isSharing && !sharer" class="absolute inset-0 flex flex-col items-center justify-center text-white">
            <n-icon :size="80" class="text-gray-600 mb-4"><i class="iconfont icon-screen-share" aria-hidden="true"></i></n-icon>
            <h3 class="text-xl font-bold mb-2">等待屏幕共享</h3>
            <p class="text-gray-400">暂无成员共享屏幕</p>
          </div>

          <!-- 共享者信息 -->
          <div v-if="sharer" class="absolute top-4 left-4 bg-black bg-opacity-70 px-4 py-2 rounded-lg">
            <div class="flex items-center gap-2 text-white">
              <n-avatar :size="30" :src="sharer.avatar || undefined">
                <span v-if="!sharer.avatar">{{ sharer.nickname?.charAt(0) || sharer.username?.charAt(0) }}</span>
              </n-avatar>
              <span class="font-semibold">
                {{ sharer.nickname || sharer.username }} 正在共享
              </span>
            </div>
          </div>

          <!-- 视频质量指示器 -->
          <div class="absolute top-4 right-4 bg-black bg-opacity-70 px-3 py-1 rounded-full">
            <span class="text-white text-sm">{{ currentQualityLabel }}</span>
          </div>

          <!-- 控制覆盖层 (鼠标悬停显示) -->
          <div v-if="isSharing" class="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 px-4 py-2 rounded-lg">
            <span class="text-white text-sm">正在共享您的屏幕</span>
          </div>
        </div>
      </div>

      <!-- 侧边栏 - 参与者列表 -->
      <div class="hidden md:block w-64 flex-shrink-0 bg-gray-800 p-4 overflow-y-auto">
        <div class="text-white font-semibold mb-4">群成员 ({{ members.length }})</div>
        <div class="space-y-2">
          <div
            v-for="member in members"
            :key="member.id"
            class="flex items-center gap-3 p-2 bg-gray-700 rounded-lg"
          >
            <n-avatar :size="36" :src="member.avatar || undefined">
              <span v-if="!member.avatar">{{ member.nickname?.charAt(0) || member.username?.charAt(0) }}</span>
            </n-avatar>
            <div class="flex-1 min-w-0">
              <div class="text-white text-sm font-medium truncate">
                {{ member.nickname || member.username }}
                <SpeakingIndicator :stream="member.id === currentUser?.id ? localStream : peerRegistry.get(member.id)?.stream" :muted="member.id === currentUser?.id && isMicMuted" />
                {{ member.id === currentUser?.id ? ' (我)' : '' }}
              </div>
              <div class="flex items-center gap-1">
                <n-tag v-if="member.role === 'owner'" type="warning" size="tiny">群主</n-tag>
                <n-tag
                  :type="isMemberParticipating(member.id) ? 'success' : 'default'"
                  size="tiny"
                >
                  {{ isMemberParticipating(member.id) ? '参与中' : '未参与' }}
                </n-tag>
                <n-icon v-if="member.isMicMuted"  :size="14" color="#ef4444"><i class="iconfont icon-microphone-off" aria-hidden="true"></i></n-icon>
              </div>
            </div>
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
let mediaClaim: MediaClaim | null = null;
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { getGroupDetail, type GroupMember } from '@/api/group';
import { limitVideoBitrate } from '@/services/mediaBitrate';
import { useAuthStore } from '@/stores/auth';
import { useSocketStore } from '@/stores/socket';
import MediaRecorder from '@/components/MediaRecorder.vue';
import MediaVideo from '@/components/MediaVideo.vue';
import SpeakingIndicator from '@/components/SpeakingIndicator.vue';
import { containedVideoRect } from '@/services/annotationGeometry';
import ScreenAnnotation from '@/components/ScreenAnnotation.vue';
import { takeCapturedGroupScreen } from '@/services/screenShareLaunch';
import { groupSessionState } from '@/services/groupSessionState';
import {
  createMediaParticipantState,
  type ParticipantSnapshot,
} from '@/services/mediaParticipantState';
import {
  RemotePeerRegistry,
  type RemoteMember,
} from '@/services/remotePeerRegistry';
import {
  createScreenAnnotationState,
  type AnnotationAction,
  type AnnotationDraft,
} from '@/services/screenAnnotationState';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const authStore = useAuthStore();
const { currentUser } = storeToRefs(authStore);
const socketStore = useSocketStore();
const { socket, authenticated } = storeToRefs(socketStore);

const groupId = ref(parseInt(route.params.id as string));

const groupInfo = ref<any>(null);
const members = ref<(GroupMember & { socketId?: string; isMicMuted?: boolean })[]>([]);

const isSharing = ref(false); // 当前用户是否正在共享
const sharer = ref<any>(null); // 当前共享者信息
const isMicMuted = ref(false);
const showMemberControl = ref(false);
const showAnnotation = ref(false); // 是否显示标注
const pendingInitialScreen = ref<MediaStream | null>(null);

const localStream = ref<MediaStream | null>(null);
const remoteStream = ref<MediaStream | null>(null);
const peerRegistry = new RemotePeerRegistry(createPeerConnection);
const annotationState = createScreenAnnotationState();
const participantState = createMediaParticipantState();
const currentQuality = ref('high'); // 当前视频质量
const screenStream = computed(() => isSharing.value ? localStream.value : remoteStream.value); // 用于录制
const displayStream = computed(() => isSharing.value ? localStream.value : remoteStream.value);
const screenSession = computed(() => groupSessionState.getSession(groupId.value, 'screen'));
const screenViewport = ref<HTMLElement | null>(null);
const viewportSize = ref({ width: 0, height: 0 });
const videoSize = ref({ width: 0, height: 0 });
const annotationBounds = computed(() => {
  const { width, height } = containedVideoRect(viewportSize.value, videoSize.value);
  return { width: `${width}px`, height: `${height}px`, left: `${(viewportSize.value.width - width) / 2}px`, top: `${(viewportSize.value.height - height) / 2}px` };
});
function updateVideoDimensions(event: Event) {
  const video = event.target as HTMLVideoElement;
  videoSize.value = { width: video.videoWidth, height: video.videoHeight };
}
let viewportObserver: ResizeObserver | null = null;
onMounted(() => {
  if (!screenViewport.value) return;
  const resize = () => { viewportSize.value = { width: screenViewport.value!.clientWidth, height: screenViewport.value!.clientHeight }; };
  resize();
  viewportObserver = new ResizeObserver(resize);
  viewportObserver.observe(screenViewport.value);
});
onUnmounted(() => viewportObserver?.disconnect());
const annotationActions = annotationState.actions;
const annotationDrafts = annotationState.drafts;
const participantUserIds = computed(() => {
  participantState.version.value;
  return participantState.userIds(groupId.value, 'screen');
});
let joinedCall = false;
let currentSessionStartedAt: string | null = null;
let cleanedUp = false;
let stopAuthenticatedWatch: (() => void) | null = null;

// 视频质量配置
const qualityPresets = {
  low: { width: 1280, height: 720, frameRate: 15 },
  medium: { width: 1920, height: 1080, frameRate: 24 },
  high: { width: 1920, height: 1080, frameRate: 30 },
  ultra: { width: 2560, height: 1440, frameRate: 30 },
};

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

// 当前质量标签
const currentQualityLabel = computed(() => {
  const labels: any = {
    low: '流畅 720p',
    medium: '标清 1080p',
    high: '高清 1080p',
    ultra: '超清 2K',
  };
  return labels[currentQuality.value];
});

// 质量选项
const qualityOptions = computed(() => [
  { label: '流畅 720p@15fps', key: 'low' },
  { label: '标清 1080p@24fps', key: 'medium' },
  { label: '高清 1080p@30fps', key: 'high' },
  { label: '超清 2K@30fps', key: 'ultra' },
]);

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

// 初始化Socket连接
function initSocket() {
  socketStore.joinGroup(groupId.value);
  const target = socket.value;
  if (!target) return;

  stopAuthenticatedWatch = watch(
    authenticated,
    ready => {
      if (!ready) return;
      if (isSharing.value) {
        // 初次授权时 Socket 可能仍在认证；认证完成后补发邀请。
        socket.value?.emit('group_call_start', { groupId: groupId.value, deviceType: 2 });
      }
      const session = groupSessionState.getSession(groupId.value, 'screen');
      if (session) joinScreenCall(session.ownerUserId);
    },
    { immediate: true },
  );

  // 接收群组成员列表
  target.on('group_call_state', handleCallState);
  target.on('group_call_members', handleCallMembers);
  target.on('group_call_member_joined', handleCallMemberJoined);
  target.on('group_call_member_left', handleCallMemberLeft);
  target.on('group_call_presence', handleCallPresence);
  target.on('disconnect', handleSocketDisconnect);

  // 通话开始
  target.on('group_call_started', handleCallStarted);

  // 通话结束
  target.on('group_call_ended', handleCallEnded);
  target.on('group_access_revoked', handleGroupAccessRevoked);
  target.on('group_call_error', handleGroupCallError);

  // WebRTC 信令
  target.on('group_webrtc_offer', handleOffer);
  target.on('group_webrtc_answer', handleAnswer);
  target.on('group_webrtc_ice', handleIceCandidate);

  // 麦克风权限变化
  target.on('mic_permission_changed', handleMicPermissionChanged);

  // 成员麦克风状态变化
  target.on('member_mic_changed', handleMemberMicChanged);

  // 屏幕标注状态
  target.on('screen_annotation_snapshot', handleAnnotationSnapshot);
  target.on('screen_annotation_draft', handleAnnotationDraft);
  target.on('screen_annotation_complete', handleAnnotationComplete);
  target.on('screen_annotation_undo', handleAnnotationUndo);
  target.on('screen_annotation_clear', handleAnnotationClear);
  target.on('screen_annotation_error', handleAnnotationError);
}

// 开始屏幕共享
async function startScreenShare() {
  if (!mediaClaim?.isCurrent() || cleanedUp) return;
  try {
    const preset = qualityPresets[currentQuality.value as keyof typeof qualityPresets];

    // 获取屏幕共享流
    const screenStream = pendingInitialScreen.value || await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
      audio: false,
    });

    pendingInitialScreen.value = null;
    if (cleanedUp || !mediaClaim?.isCurrent()) { screenStream.getTracks().forEach(track => track.stop()); return; }
    // 获取音频流 (如果需要语音)
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch(() => null);

    if (cleanedUp || !mediaClaim?.isCurrent()) { screenStream.getTracks().forEach(track => track.stop()); audioStream?.getTracks().forEach(track => track.stop()); return; }
    // 合并流
    localStream.value = new MediaStream([
      ...screenStream.getVideoTracks(),
      ...(audioStream?.getAudioTracks() || []),
    ]);

    isSharing.value = true;
    sharer.value = currentUser.value;

    // 通知服务器开始共享
    socket.value?.emit('group_call_start', {
      groupId: groupId.value,
      deviceType: 2, // 2: 屏幕共享
    });

    // 监听屏幕共享停止
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        stopScreenShare();
      };
    }

    // 向所有成员发送流
    await broadcastStream();
  } catch (error: any) {
    message.error('开始屏幕共享失败: ' + error.message);
  }
}

// 停止屏幕共享
function stopScreenShare() {
  localStream.value?.getTracks().forEach(track => track.stop());
  localStream.value = null;
  isSharing.value = false;
  showAnnotation.value = false;
  annotationState.clear();
  participantState.clear(groupId.value, 'screen');

  peerRegistry.clear();
  socket.value?.emit('group_call_end', { groupId: groupId.value, deviceType: 2 });
  socket.value?.emit('leave_group_call', { groupId: groupId.value, deviceType: 2 });
  joinedCall = false;
  sharer.value = null;
  message.info('已停止屏幕共享');
}

// 广播流到所有成员
async function broadcastStream() {
  const targets = peerRegistry.values().filter(peer => peer.id !== currentUser.value?.id);
  await Promise.all(targets.map(member => createAndSendOffer(member)));
  // 这里简化处理，实际应该为每个成员创建独立的连接
  // 在实际应用中，应该使用 SFU (Selective Forwarding Unit) 服务器
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
  if (localStream.value) {
    localStream.value.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream.value!);
      if (track.kind === 'video') void limitVideoBitrate(sender, 1_800_000);
    });
  }

  if (!isSharing.value) pc.addTransceiver('video', { direction: 'recvonly' });
  if (!localStream.value?.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });

  // 处理远程流
  pc.ontrack = (event) => {
    if (event.streams[0]) {
      peerRegistry.setStream(member.id, event.streams[0]);
      if (event.streams[0].getVideoTracks().length) remoteStream.value = event.streams[0];
    }
  };

  // ICE 候选
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.value?.emit('group_webrtc_ice', {
        startedAt,
        to: member.socketId,
        candidate: event.candidate,
        groupId: groupId.value,
        deviceType: 2,
      });
    }
  };
  return pc;
}

async function createAndSendOffer(member: RemoteMember) {
  const startedAt = currentSessionStartedAt;
  const peer = peerRegistry.upsert(member);
  const pc = peer.connection as RTCPeerConnection;
  if (pc.signalingState !== 'stable') return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.value?.emit('group_webrtc_offer', {
    startedAt,
    to: member.socketId,
    offer,
    deviceType: 2,
    groupId: groupId.value,
  });
}

// 处理 offer
async function handleOffer(data: any) {
  if (!currentSessionStartedAt || data.startedAt !== currentSessionStartedAt || cleanedUp) return;
  if (data.groupId !== groupId.value || data.deviceType !== 2 || !data.fromUser) return;
  const peer = peerRegistry.upsert({ ...data.fromUser, socketId: data.from });
  const pc = peer.connection as RTCPeerConnection;
  await pc.setRemoteDescription(data.offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.value?.emit('group_webrtc_answer', {
    startedAt: data.startedAt,
    to: data.from,
    answer,
    deviceType: 2,
    groupId: groupId.value,
  });
}

// 处理 answer
async function handleAnswer(data: any) {
  if (!currentSessionStartedAt || data.startedAt !== currentSessionStartedAt || cleanedUp) return;
  if (data.groupId !== groupId.value || data.deviceType !== 2) return;
  const pc = findPeerBySocket(data.from)?.connection as RTCPeerConnection | undefined;
  if (pc) await pc.setRemoteDescription(data.answer);
}

// 处理 ICE 候选
async function handleIceCandidate(data: any) {
  if (!currentSessionStartedAt || data.startedAt !== currentSessionStartedAt || cleanedUp) return;
  if (data.groupId !== groupId.value || data.deviceType !== 2) return;
  const pc = findPeerBySocket(data.from)?.connection as RTCPeerConnection | undefined;
  if (pc) await pc.addIceCandidate(data.candidate);
}

function findPeerBySocket(socketId: string) {
  return peerRegistry.values().find(peer => peer.socketId === socketId);
}

function handleCallState(data: any) {
  if (data.groupId !== groupId.value) return;
  const session = data.sessions.screen;
  if (session) {
    startScreenSession(session.startedAt, session.channelId);
    joinScreenCall(session.ownerUserId);
  } else if (!isSharing.value) {
    sharer.value = null;
    remoteStream.value = null;
  }
}

async function joinScreenCall(ownerUserId: number) {
  if (!mediaClaim?.isCurrent() || cleanedUp) return;
  const owner = members.value.find(member => member.id === ownerUserId);
  sharer.value = owner || { id: ownerUserId, username: '共享者' };
  const session = groupSessionState.getSession(groupId.value, 'screen');
  if (session) startScreenSession(session.startedAt, session.channelId);
  if (joinedCall) return;
  joinedCall = true;
  if (!localStream.value) {
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!joinedCall || cleanedUp) { audio.getTracks().forEach(track => track.stop()); return; }
      audio.getAudioTracks().forEach(track => { track.enabled = !isMicMuted.value && canSpeak.value; });
      localStream.value = audio;
    } catch { isMicMuted.value = true; message.warning('麦克风不可用，仍可观看屏幕共享'); }
  }
  socket.value?.emit('join_group_call', { groupId: groupId.value, deviceType: 2, startedAt: currentSessionStartedAt });
}

function handleCallStarted(data: any) {
  if (data.groupId !== groupId.value || data.deviceType !== 2) return;
  // 屏幕共享开始
  if (data.from !== socket.value?.id) {
    sharer.value = data.user;
    message.info(`${data.user?.nickname || data.user?.username} 开始共享屏幕`);
  }
  startScreenSession(data.startedAt, data.channelId);
  joinScreenCall(data.ownerUserId || data.user?.id);
}

function handleCallEnded(data: any) {
  if (cleanedUp || (data.startedAt && data.startedAt !== currentSessionStartedAt)) return;
  if (data.groupId !== groupId.value || data.deviceType !== 2) return;
  sharer.value = null;
  remoteStream.value = null;
  joinedCall = false;
  isSharing.value = false;
  currentSessionStartedAt = null;
  localStream.value?.getTracks().forEach(track => track.stop());
  localStream.value = null;
  showAnnotation.value = false;
  annotationState.clear();
  participantState.clear(groupId.value, 'screen');
  peerRegistry.clear();
  message.info('屏幕共享已结束');
}

function handleCallMembers(data: any) {
  if (cleanedUp || data.startedAt !== currentSessionStartedAt) return;
  if (data.groupId !== groupId.value || data.type !== 'screen') return;
  data.members.forEach((member: RemoteMember) => {
    if (member.id === currentUser.value?.id) return;
    peerRegistry.upsert(member);
    mergeMemberSocket(member);
  });
  peerRegistry.values().forEach(member => {
    if ((currentUser.value?.id || 0) < member.id) void createAndSendOffer(member);
  });
}

function handleCallMemberJoined(data: any) {
  if (cleanedUp || data.startedAt !== currentSessionStartedAt) return;
  if (data.groupId !== groupId.value || data.type !== 'screen') return;
  if (data.member.id === currentUser.value?.id) return;
  peerRegistry.upsert(data.member);
  mergeMemberSocket(data.member);
  if ((currentUser.value?.id || 0) < data.member.id) void createAndSendOffer(data.member);
}

function handleCallMemberLeft(data: any) {
  if (cleanedUp || data.startedAt !== currentSessionStartedAt) return;
  if (data.groupId !== groupId.value || data.type !== 'screen' || !data.userId) return;
  peerRegistry.remove(data.userId, data.socketId);
}

function handleGroupAccessRevoked(data: { groupId: number }) {
  if (data.groupId !== groupId.value) return;
  cleanupScreenCall(false);
  message.warning('群组访问权限已失效，共享已停止');
  void router.replace('/groups');
}
function handleGroupCallError(data: { groupId: number; message?: string }) {
  if (data.groupId !== groupId.value || cleanedUp) return;
  cleanupScreenCall(false);
  message.error(data.message || '无法加入群组共享');
  void router.replace('/groups');
}
function handleSocketDisconnect() {
  cleanupScreenCall(false);
  message.warning('连接已断开，共享已停止');
  void router.replace('/groups');
}

function startScreenSession(startedAt: string, channelId: string) {
  currentSessionStartedAt = startedAt;
  annotationState.startSession(startedAt);
  participantState.setChannel(groupId.value, 'screen', channelId);
}

function handleCallPresence(data: ParticipantSnapshot) {
  if (data.groupId !== groupId.value || data.type !== 'screen') return;
  participantState.apply(data);
}

function isMemberParticipating(userId: number) {
  participantState.version.value;
  return participantState.isParticipating(groupId.value, 'screen', userId);
}

function isCurrentAnnotationEvent(data: { groupId: number; startedAt: string }) {
  return data.groupId === groupId.value
    && data.startedAt === screenSession.value?.startedAt;
}

function handleAnnotationSnapshot(data: {
  groupId: number;
  startedAt: string;
  actions: AnnotationAction[];
}) {
  if (!isCurrentAnnotationEvent(data)) return;
  annotationState.applySnapshot(data.startedAt, data.actions);
}

function handleAnnotationDraft(data: {
  groupId: number;
  startedAt: string;
  action: AnnotationDraft;
}) {
  if (!isCurrentAnnotationEvent(data)) return;
  annotationState.applyDraft(data.startedAt, data.action);
}

function handleAnnotationComplete(data: {
  groupId: number;
  startedAt: string;
  action: AnnotationAction;
}) {
  if (!isCurrentAnnotationEvent(data)) return;
  annotationState.applyComplete(data.startedAt, data.action);
}

function handleAnnotationUndo(data: {
  groupId: number;
  startedAt: string;
  actionId: string | null;
}) {
  if (!isCurrentAnnotationEvent(data)) return;
  annotationState.applyUndo(data.startedAt, data.actionId);
}

function handleAnnotationClear(data: { groupId: number; startedAt: string }) {
  if (!isCurrentAnnotationEvent(data)) return;
  annotationState.startSession(data.startedAt);
  annotationState.applySnapshot(data.startedAt, []);
}

function handleAnnotationError(data: { message?: string }) {
  message.error(data.message || '标注操作失败');
}

function emitAnnotation(event: string, payload: Record<string, unknown> = {}) {
  const session = screenSession.value;
  if (!session || !isSharing.value) return;
  socket.value?.emit(event, {
    groupId: groupId.value,
    startedAt: session.startedAt,
    ...payload,
  });
}

function sendAnnotationDraft(action: AnnotationDraft) {
  const session = screenSession.value;
  if (!session) return;
  annotationState.applyDraft(session.startedAt, action);
  emitAnnotation('screen_annotation_draft', { action });
}

function sendAnnotationComplete(action: AnnotationDraft) {
  const session = screenSession.value;
  if (!session) return;
  annotationState.applyDraft(session.startedAt, action);
  emitAnnotation('screen_annotation_complete', { action });
}

function sendAnnotationUndo() {
  emitAnnotation('screen_annotation_undo');
}

function sendAnnotationClear() {
  emitAnnotation('screen_annotation_clear');
}

function mergeMemberSocket(member: RemoteMember) {
  const groupMember = members.value.find(item => item.id === member.id);
  if (groupMember) groupMember.socketId = member.socketId;
}

function handleMemberMicChanged(data: any) {
  const member = members.value.find(item => item.socketId === data.socketId);
  if (member) member.isMicMuted = data.muted;
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

// 修改视频质量
async function handleQualityChange(key: string) {
  currentQuality.value = key;
  message.success(`视频质量已切换为 ${currentQualityLabel.value}`);

  // 如果正在共享，重新获取流
  if (isSharing.value) {
    const wasSharing = isSharing.value;
    stopScreenShare();
    if (wasSharing) {
      await startScreenShare();
    }
  }
}

// 退出
function handleExit() {
  cleanupScreenCall(true);
  router.back();
}

function cleanupScreenCall(endOwnedSession: boolean) {
  if (cleanedUp) return;
  cleanedUp = true;
  currentSessionStartedAt = null;
  const ownedMedia = !!mediaClaim;
  mediaClaim?.release();
  mediaClaim = null;
  if (!ownedMedia) return;

  pendingInitialScreen.value?.getTracks().forEach(track => track.stop());
  pendingInitialScreen.value = null;
  localStream.value?.getTracks().forEach(track => track.stop());
  peerRegistry.clear();
  annotationState.clear();
  participantState.clear(groupId.value, 'screen');
  if (endOwnedSession && groupSessionState.getSession(groupId.value, 'screen')?.ownerUserId === currentUser.value?.id) {
    socket.value?.emit('group_call_end', { groupId: groupId.value, deviceType: 2 });
  }
  socket.value?.emit('leave_group_call', { groupId: groupId.value, deviceType: 2 });
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
  socket.value?.off('disconnect', handleSocketDisconnect);
  socket.value?.off('group_call_started', handleCallStarted);
  socket.value?.off('group_call_ended', handleCallEnded);
  socket.value?.off('group_access_revoked', handleGroupAccessRevoked);
  socket.value?.off('group_call_error', handleGroupCallError);
  socket.value?.off('group_webrtc_offer', handleOffer);
  socket.value?.off('group_webrtc_answer', handleAnswer);
  socket.value?.off('group_webrtc_ice', handleIceCandidate);
  socket.value?.off('mic_permission_changed', handleMicPermissionChanged);
  socket.value?.off('member_mic_changed', handleMemberMicChanged);
  socket.value?.off('screen_annotation_snapshot', handleAnnotationSnapshot);
  socket.value?.off('screen_annotation_draft', handleAnnotationDraft);
  socket.value?.off('screen_annotation_complete', handleAnnotationComplete);
  socket.value?.off('screen_annotation_undo', handleAnnotationUndo);
  socket.value?.off('screen_annotation_clear', handleAnnotationClear);
  socket.value?.off('screen_annotation_error', handleAnnotationError);
}

// 录制功能回调
function handleRecordingStart() {
  message.success('开始录制屏幕共享');
}

function handleRecordingStop(blob: Blob) {
  message.success(`录制完成，文件大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  // 可以在这里上传到服务器
}

onMounted(async () => {
  mediaClaim = mediaOccupancy.acquire('group-screen', `group-screen:${groupId.value}`, () => cleanupScreenCall(true));
  if (!mediaClaim) { message.warning('请先结束当前通话或远程控制'); await router.replace(`/group-chat/${groupId.value}`); return; }
  const captured = takeCapturedGroupScreen(groupId.value);
  if (captured) {
    // 回填给 startScreenShare，避免切换路由后再次请求共享权限。
    pendingInitialScreen.value = captured;
  }
  await loadGroupDetail();
  if (cleanedUp || !mediaClaim?.isCurrent()) return;
  initSocket();
  if (pendingInitialScreen.value) await startScreenShare();
});

onUnmounted(() => {
  cleanupScreenCall(true);
});
</script>
