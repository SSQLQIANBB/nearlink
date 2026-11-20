<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MeetingTranscriptPlayback from '@/components/MeetingTranscriptPlayback.vue';
import MeetingSummaryContent from '@/components/MeetingSummaryContent.vue';
import MeetingRecordingPanel from './meetingMinutes.vue';
import { PHASE } from '@/services/meetingMinutes';
import { useMeetingUpdates } from '@/services/meetingMinutes/useMeetingUpdates';
import { useMeetingMinutesStore } from '@/stores/meetingMinutes';
import {
  NButton,
  NCheckbox,
  NDropdown,
  NEmpty,
  NSpin,
  NTag,
  NPagination,
  NAlert,
  useDialog,
  useMessage,
  type DialogReactive,
} from 'naive-ui';
import {
  getMeetings,
  getMeeting,
  generateMeetingSummary,
  regenerateMeetingTranscript,
  deleteMeeting,
  deleteMeetings,
  renameMeeting,
  retryMeetingAudio,
  type MeetingListItem,
  type MeetingDetail,
  type MeetingUpdate,
} from '@/api/meeting';

const router = useRouter();
const route = useRoute();
const dialog = useDialog();
const message = useMessage();
const recording = useMeetingMinutesStore();
const openingRecording = ref(false);
const showingRecording = computed(() => route.name === 'Meetings' && route.query.recording === '1');
const offlineRecordingId = computed(() =>
  recording.isActive && recording.source === 'offline' ? recording.sessionId : null,
);
const callRecordingActive = computed(() =>
  recording.isActive && recording.source === 'call' && !!recording.ownerCallId,
);
const recordingButtonLabel = computed(() => {
  if (callRecordingActive.value) return '通话纪要进行中';
  return recording.isActive ? '返回录音' : '新建录音';
});

async function openRecording() {
  if (showingRecording.value || openingRecording.value || callRecordingActive.value) return;
  openingRecording.value = true;
  try {
    if (recording.phase === PHASE.ENDED) await recording.dispose();
    if (!viewLifetime.signal.aborted) {
      await router.replace({ name: 'Meetings', query: { ...route.query, recording: '1' } });
    }
  } finally {
    openingRecording.value = false;
  }
}

const pageSize = 20;
const items = ref<MeetingListItem[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const loadError = ref('');
const libraryListEl = ref<HTMLElement | null>(null);
let listController: AbortController | null = null;
let listUpdates: Map<string, MeetingUpdate> | null = null;
let locatingTarget: string | undefined;
let detailController: AbortController | null = null;
let deleteConfirmation: DialogReactive | null = null;
let requestedPage = 1;

const selectedId = ref<string | null>(null);
const displayedMeetingId = computed(() => showingRecording.value ? offlineRecordingId.value : selectedId.value);
const detailError = ref('');
const detail = ref<MeetingDetail | null>(null);
const detailLoading = ref(false);
const detailScrollEl = ref<HTMLElement | null>(null);
const activeTab = ref<'transcript' | 'summary'>('transcript');
const viewLifetime = new AbortController();
const renaming = ref(false);
const newTitle = ref('');
type MeetingAction = 'summary' | 'transcript' | 'rename' | 'delete' | 'audio';
const pendingActions = reactive(new Map<string, MeetingAction>());
const currentAction = computed(() =>
  selectedId.value ? pendingActions.get(selectedId.value) : undefined,
);
const activeRecording = computed(
  () => detail.value && ['recording', 'paused', 'finalizing'].includes(detail.value.status),
);

const batchMode = ref(false);
const batchDeleting = ref(false);
const checkedMeetings = reactive(new Set<string>());
const deletableItems = computed(() => items.value.filter(canDeleteMeeting));
const checkedOnPage = computed(() => deletableItems.value.filter(item => checkedMeetings.has(item.sessionId)).length);

function canDeleteMeeting(item: MeetingListItem) {
  return ['ended', 'failed'].includes(item.status) && !['recording', 'pending', 'uploading'].includes(item.audioStatus) &&
    item.summaryStatus !== 'generating' && !pendingActions.has(item.sessionId);
}

function toggleMeeting(item: MeetingListItem, checked: boolean) {
  if (batchDeleting.value || !canDeleteMeeting(item)) return;
  if (!checked) checkedMeetings.delete(item.sessionId);
  else if (checkedMeetings.size < 50) checkedMeetings.add(item.sessionId);
}

function togglePageMeetings(checked: boolean) {
  for (const item of deletableItems.value) toggleMeeting(item, checked);
}

function leaveBatchMode() {
  batchMode.value = false;
  checkedMeetings.clear();
}

/** 音频可播放：已上传（ready）或尾片不完整但已有内容（partial），且签名地址有效。 */
const audioPlayable = computed(
  () => !!detail.value?.audioUrl && ['ready', 'partial'].includes(detail.value?.audioStatus ?? ''),
);
/** 六态文案：仅在不可播放时展示准确说明；不暴露七牛 key/存储引用/堆栈。 */
const audioStatusNote = computed(() => {
  if (!detail.value) return '';
  switch (detail.value.audioStatus) {
    case 'recording':
      return '正在录制，结束后才能播放。';
    case 'pending':
      return '录音正在保存，请稍候。';
    case 'uploading':
      return '录音正在上传，请稍候。';
    case 'ready':
      return detail.value.audioUrl ? '' : '暂时无法获取播放地址，请刷新详情。';
    case 'partial':
      return detail.value.audioUrl ? '录音未正常结束，部分音频可能缺失。' : '暂时无法获取播放地址，请刷新详情。';
    case 'failed':
      return '音频保存失败，文字内容已保留，可稍后重试。';
    case 'missing':
      return '该会议没有保存音频（早期版本录制或无音频）。';
    default:
      return '';
  }
});

// ---- 播放器：声明式绑定 src，签名过期重取址绑定发起时的 sessionId，限制重试次数 ----
const audioEl = ref<HTMLAudioElement | null>(null);
const audioPlayerEl = ref<HTMLElement | null>(null);
const audioAnchor = ref<HTMLElement | null>(null);
const audioStuck = ref(false);
watch([detailScrollEl, audioAnchor], ([panel, anchor], _, onCleanup) => {
  audioStuck.value = false;
  if (!panel || !anchor) return;
  const observer = new IntersectionObserver(([entry]) => {
    audioStuck.value = !!entry?.rootBounds && entry.boundingClientRect.bottom <= entry.rootBounds.top;
  }, { root: panel });
  observer.observe(anchor);
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });
const audioFailed = ref(false);
const audioDuration = ref(0);
const audioPlaying = ref(false);
const playbackRate = ref(1);
const downloadingAudio = ref(false);
const playbackPosition = ref<number | null>(null);
const playbackPositionMs = computed(() => playbackPosition.value === null ? null : playbackPosition.value * 1000);
const playbackProgress = computed(() => audioDuration.value
  ? Math.min(100, ((playbackPosition.value ?? 0) / audioDuration.value) * 100)
  : 0);
const audioMenuOptions = computed(() => [
  {
    label: '下载录音',
    key: 'download',
    disabled: downloadingAudio.value,
    icon: () => h('i', { class: 'iconfont icon-xiazai', 'aria-hidden': true }),
  },
  {
    label: `播放速度 · ${playbackRate.value}×`,
    key: 'speed',
    icon: () => h('i', { class: 'iconfont icon-play', 'aria-hidden': true }),
    children: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => ({
      label: rate === 1 ? '1× · 正常' : `${rate}×`,
      key: rate,
    })),
  },
]);
let reloadAttempts = 0;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let audioController: AbortController | null = null;
/** 换址前记录播放意图与位置，load 后依据用户此前是否在播决定是否继续播放。 */
const resumePlayback = ref(false);

function clearAudioState() {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  reloadAttempts = 0;
  audioController?.abort();
  audioController = null;
  resumePlayback.value = false;
  playbackPosition.value = null;
  audioDuration.value = 0;
  audioPlaying.value = false;
  audioFailed.value = false;
}

/** 切换会议/离开时：停止旧音频并清理其重试任务（v-if 卸载元素，这里清状态）。 */
function stopAudio() {
  if (audioEl.value) audioEl.value.pause();
  clearAudioState();
}

/** 播放位置记录：拖动或自然播放时缓存，供换址后恢复。 */
function trackPosition() {
  const el = audioEl.value;
  if (!el || el.readyState === 0) return;
  playbackPosition.value = el.currentTime;
}

function formatPlaybackTime(value: number) {
  const seconds = Math.floor(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

function syncAudioDuration() {
  const duration = audioEl.value?.duration;
  audioDuration.value = duration && Number.isFinite(duration) ? duration : 0;
}

function toggleAudioPlayback() {
  const player = audioEl.value;
  if (!player) return;
  if (!player.paused) player.pause();
  else void player.play().catch(error => {
    if (player === audioEl.value && error.name === 'NotAllowedError') message.warning('当前环境无法播放录音');
  });
}

function scrubAudio(event: Event) {
  const player = audioEl.value;
  if (!player || !audioDuration.value) return;
  player.currentTime = (event.currentTarget as HTMLInputElement).valueAsNumber;
  trackPosition();
}

async function selectAudioAction(key: string | number) {
  if (typeof key === 'number' && audioEl.value) {
    audioEl.value.playbackRate = key;
    playbackRate.value = key;
    return;
  }
  const sessionId = detail.value?.sessionId;
  if (key !== 'download' || !sessionId || downloadingAudio.value) return;
  downloadingAudio.value = true;
  try {
    const { meeting } = await getMeeting(sessionId, viewLifetime.signal);
    if (viewLifetime.signal.aborted || detail.value?.sessionId !== sessionId) return;
    if (!meeting.audioDownloadUrl) {
      message.warning('暂时无法获取录音下载地址');
      return;
    }
    const link = document.createElement('a');
    link.href = meeting.audioDownloadUrl;
    link.download = '';
    link.rel = 'noreferrer';
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    if (!viewLifetime.signal.aborted && detail.value?.sessionId === sessionId) message.error('录音下载失败，请重试');
  } finally {
    downloadingAudio.value = false;
  }
}

function seekAudio(startMs: number) {
  const el = audioEl.value;
  const time = startMs / 1000;
  if (!el || (Number.isFinite(el.duration) && time >= el.duration)) return;
  el.currentTime = time;
  playbackPosition.value = time;
}

function followTranscript(target: Element) {
  const panel = detailScrollEl.value;
  if (!panel) return;
  const panelTop = panel.getBoundingClientRect().top + panel.clientTop;
  const bottom = panelTop + panel.clientHeight;
  const top = panelTop + (audioPlayerEl.value?.offsetHeight ?? 0);
  const item = target.getBoundingClientRect();
  if (item.top >= top && item.bottom <= bottom) return;
  // 对应文本需要出现在吸顶播放器下方，滚动只发生在详情面板内。
  panel.scrollTop += item.top - top - Math.max(0, (bottom - top - item.height) / 2);
}

/** 签名过期（error 事件）后重新取址：绑定发起时 sessionId，旧响应不改写新会议；最多 2 次。 */
function handleAudioError() {
  const current = detail.value;
  const el = audioEl.value;
  if (!current?.audioUrl || !el || audioFailed.value) return;
  if (reloadTimer) return;
  const targetSessionId = current.sessionId;
  if (reloadAttempts >= 2) {
    audioFailed.value = true;
    return;
  }
  reloadAttempts += 1;
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    if (detail.value?.sessionId !== targetSessionId || viewLifetime.signal.aborted) return;
    const controller = new AbortController();
    audioController = controller;
    try {
      const { meeting } = await getMeeting(targetSessionId, controller.signal);
      if (controller.signal.aborted || detail.value?.sessionId !== targetSessionId) return;
      // 服务端返回新地址则更新详情（触发 :src 重绑）；地址未变说明不是签名过期。
      if (meeting.audioUrl && meeting.audioUrl !== current.audioUrl) {
        detail.value = { ...detail.value, audioUrl: meeting.audioUrl, audioStatus: meeting.audioStatus };

      } else {
        audioFailed.value = true;
      }
    } catch {
      if (!controller.signal.aborted && detail.value?.sessionId === targetSessionId) audioFailed.value = true;
    }
  }, 500);
}

/** 元数据就绪（换址成功）后恢复播放位置与播放意图。 */
function handleAudioLoaded() {
  const el = audioEl.value;
  if (!el) return;
  audioFailed.value = false;
  syncAudioDuration();
  el.playbackRate = playbackRate.value;
  const savedPosition = playbackPosition.value ?? 0;
  if (savedPosition > 0 && isFinite(el.duration) && savedPosition < el.duration) {
    try {
      el.currentTime = savedPosition;
    } catch {
      /* seek 失败忽略，从头播放 */
    }
  }
  if (resumePlayback.value) {
    el.play().catch(() => undefined);
  }
  resumePlayback.value = false;
  trackPosition();
}

async function handleRetryAudio() {
  const session = selectedId.value;
  if (!session || pendingActions.has(session)) return;
  pendingActions.set(session, 'audio');
  try {
    const { meeting } = await retryMeetingAudio(session, viewLifetime.signal);
    updateMeeting(session, { audioUrl: meeting.audioUrl, audioStatus: meeting.audioStatus });
  } catch (error) {
    if (!viewLifetime.signal.aborted) message.error(error instanceof Error ? error.message : '音频重试失败');
  } finally { pendingActions.delete(session); }
}

const recordingStatusLabel: Record<string, string> = {
  recording: '录音中',
  paused: '已暂停',
  finalizing: '收尾中',
  ended: '已结束',
  failed: '异常终止',
};
const recordingStatusType: Record<string, 'default' | 'warning' | 'error' | 'success'> = {
  recording: 'warning',
  paused: 'default',
  finalizing: 'warning',
  ended: 'default',
  failed: 'error',
};
const summaryLabel: Record<string, string> = {
  idle: '',
  generating: '纪要生成中',
  ready: '已生成纪要',
  failed: '纪要生成失败',
};

function meetingGenerationLabel(item: MeetingListItem) {
  if (item.generationStage === 'transcript') return '转写生成中';
  if (item.summaryStatus === 'failed' && item.summaryError === 'final_transcript_failed') return '完整录音转写失败';
  if (item.summaryStatus === 'failed' && item.hasSummary) return '已保留上次纪要';
  return summaryLabel[item.summaryStatus] || '已生成纪要';
}

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

function formatSeconds(totalSec: number) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
function formatDate(value: string) {
  const d = new Date(value);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function load(pageNum = 1, options: { target?: string; reconnect?: boolean } = {}) {
  if (viewLifetime.signal.aborted) return;
  requestedPage = pageNum;
  locatingTarget = options.target;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  const updates = new Map<string, MeetingUpdate>();
  listUpdates = updates;
  if (!options.reconnect) loading.value = true;
  loadError.value = '';
  try {
    const res = await getMeetings(pageNum, pageSize, controller.signal, options.target);
    if (controller.signal.aborted) return;
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize));
    if (res.page > lastPage && res.items.length === 0) {
      await load(lastPage, { reconnect: options.reconnect });
      return;
    }
    items.value = res.items;
    total.value = res.total;
    page.value = res.page;
    requestedPage = res.page;
    for (const change of updates.values()) applyMeetingUpdate(change, false);
    const target = options.target;
    if (target && items.value.some(item => item.sessionId === target)) {
      if (!showingRecording.value) void selectMeeting(target);
      void nextTick(() => libraryListEl.value?.querySelector(`[data-session-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' }));
    } else if (!items.value.some((item) => item.sessionId === selectedId.value)) {
      void selectMeeting(items.value[0]?.sessionId ?? null);
    } else if (options.reconnect && selectedId.value) {
      void refreshMeetingDetail(selectedId.value);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      if (!options.reconnect || !items.value.length) loadError.value = error instanceof Error ? error.message : '加载失败';
      else if (selectedId.value) void refreshMeetingDetail(selectedId.value);
    }
  } finally {
    if (!controller.signal.aborted) {
      loading.value = false;
      if (listUpdates === updates) listUpdates = null;
      locatingTarget = undefined;
    }
  }
}

async function selectMeeting(sessionId: string | null) {
  detailController?.abort();
  detailController = null;
  selectedId.value = sessionId;
  detail.value = null;
  detailError.value = '';
  detailLoading.value = sessionId !== null;
  activeTab.value = 'transcript';
  renaming.value = false;
  stopAudio();
  if (detailScrollEl.value) detailScrollEl.value.scrollTop = 0;
  if (sessionId === null) return;
  await refreshMeetingDetail(sessionId);
}

async function openMeeting(item: MeetingListItem) {
  if (batchMode.value) {
    toggleMeeting(item, !checkedMeetings.has(item.sessionId));
    return;
  }
  if (item.sessionId === offlineRecordingId.value) {
    await openRecording();
    return;
  }
  if (showingRecording.value) {
    const failure = await router.replace({ name: 'Meetings', query: { ...route.query, recording: undefined } });
    if (failure || viewLifetime.signal.aborted) return;
  } else if (selectedId.value === item.sessionId) return;
  await selectMeeting(item.sessionId);
}

async function showFinishedMeeting(sessionId: string) {
  const alreadyTargeted = route.query.sessionId === sessionId;
  const failure = await router.replace({ name: 'Meetings', query: { sessionId } });
  if (!failure && alreadyTargeted) void load(1, { target: sessionId });
}

async function refreshMeetingDetail(sessionId: string) {
  if (viewLifetime.signal.aborted || showingRecording.value || selectedId.value !== sessionId) return;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  try {
    const { meeting } = await getMeeting(sessionId, controller.signal).catch(error => {
      if (controller.signal.aborted || !detail.value) throw error;
      return getMeeting(sessionId, controller.signal);
    });
    if (!controller.signal.aborted) {
      const previous = detail.value;
      // 已在播放时保留当前地址，避免状态通知重置播放位置。
      detail.value = previous?.audioUrl && !audioFailed.value && previous.audioStatus === meeting.audioStatus && meeting.audioUrl
        ? { ...meeting, audioUrl: previous.audioUrl } : meeting;
      detailError.value = '';
      syncMeetingListItem(sessionId, meeting);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      if (!detail.value) detailError.value = error instanceof Error ? error.message : '加载详情失败';
      else message.warning('更新会议详情失败，请重新打开会议');
    }
  } finally {
    if (!controller.signal.aborted) {
      detailLoading.value = false;
      detailController = null;
    }
  }
}

function applyMeetingUpdate(change: MeetingUpdate, refreshSelected = true) {
  const { sessionId, item, detailChanged } = change;
  if (!item) {
    checkedMeetings.delete(sessionId);
    const index = items.value.findIndex(row => row.sessionId === sessionId);
    if (index >= 0) {
      items.value.splice(index, 1);
      total.value = Math.max(0, total.value - 1);
    }
    if (refreshSelected && selectedId.value === sessionId) {
      void selectMeeting(batchDeleting.value || pendingActions.get(sessionId) === 'delete' ? null : items.value[0]?.sessionId ?? null);
    }
    return;
  }
  if (!canDeleteMeeting(item)) checkedMeetings.delete(sessionId);
  syncMeetingListItem(sessionId, item);
  if (!showingRecording.value && selectedId.value === sessionId && (detailChanged || detailController)) {
    if (refreshSelected) void refreshMeetingDetail(sessionId);
    return;
  }
  if (selectedId.value === sessionId && detail.value) detail.value = { ...detail.value, title: item.title };
}

useMeetingUpdates(change => {
  listUpdates?.set(change.sessionId, change);
  applyMeetingUpdate(change);
}, () => void load(requestedPage, { reconnect: true, target: locatingTarget }));

function syncMeetingListItem(sessionId: string, patch: Partial<MeetingListItem>) {
  const item = items.value.find((meeting) => meeting.sessionId === sessionId);
  if (!item) return;
  if (patch.title !== undefined) item.title = patch.title;
  if (patch.summaryStatus !== undefined) item.summaryStatus = patch.summaryStatus;
  if (patch.summaryError !== undefined) item.summaryError = patch.summaryError;
  if (patch.generationStage !== undefined) item.generationStage = patch.generationStage;
  if (patch.regeneratingTranscript !== undefined) item.regeneratingTranscript = patch.regeneratingTranscript;
  if (patch.hasSummary !== undefined) item.hasSummary = patch.hasSummary;
  if (patch.status !== undefined) item.status = patch.status;
  if (patch.durationSeconds !== undefined) item.durationSeconds = patch.durationSeconds;
  if (patch.audioStatus !== undefined) item.audioStatus = patch.audioStatus;
  if (patch.endedAt !== undefined) item.endedAt = patch.endedAt;
}

function updateMeeting(sessionId: string, patch: Partial<MeetingDetail>) {
  syncMeetingListItem(sessionId, patch);
  if (detail.value?.sessionId === sessionId) {
    detail.value = { ...detail.value, ...patch };
  } else if (selectedId.value === sessionId) {
    void selectMeeting(sessionId);
  }
}

async function handleGenerateSummary() {
  const target = detail.value;
  if (!target || pendingActions.has(target.sessionId)) return;
  const { sessionId } = target;
  pendingActions.set(sessionId, 'summary');
  try {
    await generateMeetingSummary(sessionId, viewLifetime.signal);
    await refreshMeetingDetail(sessionId);
  } catch (error) {
    if (!viewLifetime.signal.aborted && selectedId.value === sessionId) {
      message.error(error instanceof Error ? error.message : '生成纪要失败');
      await refreshMeetingDetail(sessionId);
    }
  } finally {
    pendingActions.delete(sessionId);
  }
}

async function handleRegenerateTranscript() {
  const sessionId = detail.value?.sessionId;
  if (!sessionId || pendingActions.has(sessionId)) return;
  pendingActions.set(sessionId, 'transcript');
  try {
    await regenerateMeetingTranscript(sessionId, viewLifetime.signal);
    await refreshMeetingDetail(sessionId);
  } catch (error) {
    if (!viewLifetime.signal.aborted && selectedId.value === sessionId) {
      message.error(error instanceof Error ? error.message : '重新生成转写失败');
    }
  } finally {
    pendingActions.delete(sessionId);
  }
}

function startRename() {
  if (!detail.value) return;
  newTitle.value = detail.value.title;
  renaming.value = true;
}

async function handleRename() {
  const target = detail.value;
  const title = newTitle.value.trim();
  if (!target || !title || pendingActions.has(target.sessionId)) return;
  const { sessionId } = target;
  pendingActions.set(sessionId, 'rename');
  try {
    await renameMeeting(sessionId, title, viewLifetime.signal);
    if (viewLifetime.signal.aborted) return;
    updateMeeting(sessionId, { title });
    if (selectedId.value === sessionId) {
      renaming.value = false;
      message.success('标题已更新');
    }
  } catch (error) {
    if (!viewLifetime.signal.aborted && selectedId.value === sessionId) {
      message.error(error instanceof Error ? error.message : '修改标题失败');
    }
  } finally {
    pendingActions.delete(sessionId);
  }
}

function confirmDelete() {
  const sessionId = detail.value?.sessionId;
  if (!sessionId || deleteConfirmation || pendingActions.has(sessionId)) return;
  deleteConfirmation = dialog.warning({
    title: '删除会议记录？',
    content: '删除后不可恢复。',
    positiveText: '确认删除',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    onPositiveClick: () => deleteConfirmedMeeting(sessionId),
    onAfterLeave: () => { deleteConfirmation = null; },
  });
}

async function deleteConfirmedMeeting(sessionId: string) {
  if (viewLifetime.signal.aborted || pendingActions.has(sessionId)) return;
  pendingActions.set(sessionId, 'delete');
  try {
    await deleteMeeting(sessionId, viewLifetime.signal);
    if (viewLifetime.signal.aborted) return;
    if (selectedId.value === sessionId) void selectMeeting(null);
    message.success('已删除');
    await load(requestedPage);
  } catch (error) {
    if (!viewLifetime.signal.aborted)
      message.error(error instanceof Error ? error.message : '删除失败');
  } finally {
    pendingActions.delete(sessionId);
  }
}

function confirmBatchDelete() {
  if (batchDeleting.value || deleteConfirmation || !checkedMeetings.size) return;
  const sessionIds = [...checkedMeetings];
  deleteConfirmation = dialog.warning({
    title: '批量删除会议记录？',
    content: `确定删除选中的 ${sessionIds.length} 条会议记录吗？删除后不可恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      batchDeleting.value = true;
      try {
        const { deletedCount } = await deleteMeetings(sessionIds, viewLifetime.signal);
        if (viewLifetime.signal.aborted) return;
        if (selectedId.value && sessionIds.includes(selectedId.value)) void selectMeeting(null);
        leaveBatchMode();
        message.success(`已删除 ${deletedCount} 条会议记录`);
        await load(requestedPage);
      } catch (error) {
        if (!viewLifetime.signal.aborted) message.error(error instanceof Error ? error.message : '批量删除失败');
      } finally {
        batchDeleting.value = false;
      }
    },
    onAfterLeave: () => { deleteConfirmation = null; },
  });
}

watch(() => route.query.sessionId, (target) => {
  if (route.name !== 'Meetings') return;
  const recordingTarget = showingRecording.value ? offlineRecordingId.value : null;
  void load(1, { target: recordingTarget ?? (typeof target === 'string' ? target : undefined) });
}, { immediate: true });
watch(showingRecording, (show) => {
  if (!show) return;
  detailController?.abort();
  detailController = null;
  detailLoading.value = false;
  stopAudio();
  if (detailScrollEl.value) detailScrollEl.value.scrollTop = 0;
});
watch(() => showingRecording.value ? offlineRecordingId.value : null, (sessionId) => {
  if (sessionId && locatingTarget !== sessionId && !items.value.some(item => item.sessionId === sessionId)) {
    void load(1, { target: sessionId });
  }
});
if (offlineRecordingId.value && !route.query.sessionId) void openRecording();
onBeforeUnmount(() => {
  deleteConfirmation?.destroy();
  stopAudio();
  viewLifetime.abort();
  listController?.abort();
  detailController?.abort();
});
</script>

<template>
  <div class="library-page h-full flex flex-col">
    <div
      class="library-shell flex-1 overflow-hidden flex flex-col w-full px-3 pt-2 pb-3 sm:px-6 sm:pt-3 sm:pb-6"
    >
      <div
        class="library-header flex flex-wrap items-center justify-between gap-3 mb-2 sm:mb-3 flex-shrink-0"
      >
        <h1 class="text-xl sm:text-2xl font-bold">会议纪要</h1>
        <NButton
          :loading="openingRecording"
          :disabled="callRecordingActive"
          @click="openRecording"
          type="primary"
          :aria-pressed="showingRecording"
        >
          <template #icon>
            <i class="iconfont icon-video" aria-hidden="true"></i>
          </template>
          {{ recordingButtonLabel }}
        </NButton>
      </div>

      <div class="library-columns">
        <aside
          class="library-sidebar"
          aria-label="会议列表"
        >
          <div class="sidebar-heading">
            <h2>会议列表</h2>
            <div class="sidebar-heading-actions">
              <span v-if="total">{{ total }} 条</span>
              <NButton v-if="!batchMode && items.length" size="tiny" tertiary @click="batchMode = true">批量删除</NButton>
            </div>
          </div>
          <div v-if="batchMode" class="batch-toolbar">
            <NCheckbox :checked="checkedOnPage > 0 && checkedOnPage === deletableItems.length"
              :indeterminate="checkedOnPage > 0 && checkedOnPage < deletableItems.length"
              :disabled="batchDeleting || !deletableItems.length" @update:checked="togglePageMeetings">全选</NCheckbox>
            <span class="batch-count">已选 {{ checkedMeetings.size }}</span>
            <NButton size="tiny" type="error" :loading="batchDeleting" :disabled="!checkedMeetings.size" @click="confirmBatchDelete">删除</NButton>
            <NButton size="tiny" tertiary :disabled="batchDeleting" @click="leaveBatchMode">取消</NButton>
          </div>
          <div
            ref="libraryListEl"
            class="library-list"
            :aria-busy="loading"
          >
            <div
              v-if="loading"
              class="panel-state"
            >
              <NSpin
                size="small"
                aria-label="正在加载会议"
              />
            </div>
            <NAlert
              v-else-if="loadError"
              :title="loadError"
              type="error"
            >
              <NButton
                size="small"
                @click="load(requestedPage)"
              >
                重试
              </NButton>
            </NAlert>
            <NEmpty
              v-else-if="items.length === 0"
              description="暂无会议记录"
              class="panel-state"
            />
            <ul
              v-else
              class="meeting-items"
            >
              <li
                v-for="item in items"
                :key="item.sessionId"
                :data-session-id="item.sessionId"
                class="meeting-list-item"
              >
                <NCheckbox v-if="batchMode" class="meeting-list-checkbox" :checked="checkedMeetings.has(item.sessionId)"
                  :disabled="batchDeleting || !canDeleteMeeting(item) || (checkedMeetings.size >= 50 && !checkedMeetings.has(item.sessionId))"
                  :aria-label="`选择 ${item.title || '未命名会议'}`" @update:checked="checked => toggleMeeting(item, checked)" />
                <button
                  type="button"
                  class="meeting-row"
                  :class="{ 'is-selected': displayedMeetingId === item.sessionId }"
                  :aria-current="displayedMeetingId === item.sessionId ? 'true' : undefined"
                  :disabled="batchMode && (batchDeleting || !canDeleteMeeting(item))"
                  @click="openMeeting(item)"
                >
                  <span class="meeting-row-title">{{ item.title || '未命名会议' }}</span>
                  <span class="meeting-row-meta">
                    {{ formatDate(item.createdAt) }} · {{ formatSeconds(item.durationSeconds) }}
                  </span>
                  <span class="meeting-row-tags">
                    <NTag
                      size="small"
                      :type="recordingStatusType[item.status]"
                    >
                      <span class="meeting-status-label"><NSpin v-if="item.status === 'finalizing'" :size="11" />{{ recordingStatusLabel[item.status] }}</span>
                    </NTag>
                    <NTag
                      v-if="item.summaryStatus !== 'idle' || item.hasSummary"
                      size="small"
                      :type="
                        item.summaryStatus === 'failed'
                          ? item.hasSummary ? 'warning' : 'error'
                          : item.summaryStatus === 'ready' || (item.summaryStatus === 'idle' && item.hasSummary)
                            ? 'success'
                            : 'default'
                      "
                    >
                      <span class="meeting-status-label"><NSpin v-if="item.summaryStatus === 'generating'" :size="11" />{{ meetingGenerationLabel(item) }}</span>
                    </NTag>
                  </span>
                </button>
              </li>
            </ul>
          </div>
          <div
            v-if="pageCount > 1"
            class="pagination-bar"
          >
            <NPagination
              :page="page"
              :page-count="pageCount"
              :page-slot="3"
              size="small"
              @update:page="load"
            />
          </div>
        </aside>

        <section
          ref="detailScrollEl"
          class="library-detail"
          :class="{ 'has-recording': showingRecording }"
          :aria-label="showingRecording ? '会议录音' : '会议详情'"
          :aria-busy="!showingRecording && detailLoading"
        >
          <MeetingRecordingPanel v-if="showingRecording" embedded @finished="showFinishedMeeting" />
          <div
            v-else-if="detailLoading"
            class="panel-state"
          >
            <NSpin
              size="small"
              aria-label="正在加载详情"
            />
          </div>
          <div
            v-else-if="detailError"
            class="panel-state"
          >
            <NAlert
              :title="detailError"
              type="error"
            >
              <NButton
                size="small"
                @click="selectMeeting(selectedId)"
              >
                重试
              </NButton>
            </NAlert>
          </div>
          <NEmpty
            v-else-if="!detail"
            description="请选择会议"
            class="panel-state"
          />
          <template v-else>
            <div class="detail-body">
              <!-- 标题与操作 -->
              <div class="detail-heading">
                <template v-if="renaming">
                  <input
                    v-model="newTitle"
                    class="title-input"
                    maxlength="120"
                    aria-label="会议标题"
                    @keyup.enter="handleRename"
                  />
                  <NButton
                    size="small"
                    type="primary"
                    :loading="currentAction === 'rename'"
                    :disabled="!newTitle.trim() || !!currentAction"
                    @click="handleRename"
                  >
                    保存
                  </NButton>
                  <NButton
                    size="small"
                    tertiary
                    :disabled="currentAction === 'rename'"
                    @click="renaming = false"
                  >
                    取消
                  </NButton>
                </template>
                <template v-else>
                  <h2 class="detail-title text-lg font-bold">
                    {{ detail.title || '未命名会议' }}
                  </h2>
                  <div class="detail-actions">
                    <NButton size="small" tertiary :disabled="!!currentAction" @click="startRename">重命名</NButton>
                    <NButton
                      size="small"
                      type="error"
                      tertiary
                      :disabled="activeRecording || detail.summaryStatus === 'generating' || !!currentAction"
                      @click="confirmDelete"
                    >
                      删除
                    </NButton>
                  </div>
                </template>
                <span v-if="audioPlayable" ref="audioAnchor" class="audio-anchor" aria-hidden="true" />
              </div>

              <!-- 录音播放：仅 ready/partial 且有播放地址时展示 -->
              <div v-if="audioPlayable" ref="audioPlayerEl" class="audio-sticky" :class="{ 'is-stuck': audioStuck }">
                <div class="audio-player">
                  <audio
                    v-if="!audioFailed"
                    ref="audioEl"
                    :src="detail.audioUrl ?? undefined"
                    preload="metadata"
                    hidden
                    @timeupdate="trackPosition"
                    @seeking="trackPosition"
                    @seeked="trackPosition"
                    @play="audioPlaying = resumePlayback = true"
                    @pause="audioPlaying = false; if (!audioEl?.error) resumePlayback = false"
                    @ended="audioPlaying = resumePlayback = false"
                    @durationchange="syncAudioDuration"
                    @loadedmetadata="handleAudioLoaded"
                    @error="handleAudioError"
                  ></audio>
                  <div v-if="!audioFailed" class="audio-controls" role="group" aria-label="会议录音播放器">
                    <button type="button" class="audio-control-button audio-play-button" :aria-label="audioPlaying ? '暂停' : '播放'" @click="toggleAudioPlayback">
                      <i :class="['iconfont', audioPlaying ? 'icon-zanting' : 'icon-play']" aria-hidden="true"></i>
                    </button>
                    <span class="audio-time">{{ formatPlaybackTime(playbackPosition ?? 0) }} <span aria-hidden="true">/</span> {{ audioDuration ? formatPlaybackTime(audioDuration) : '–:–' }}</span>
                    <input class="audio-progress" type="range" min="0" :max="audioDuration || 1" step="0.1"
                      :value="playbackPosition ?? 0" :disabled="!audioDuration" :style="{ '--audio-progress': `${playbackProgress}%` }"
                      aria-label="播放进度" :aria-valuetext="formatPlaybackTime(playbackPosition ?? 0)" @input="scrubAudio"
                    />
                    <NDropdown trigger="click" placement="bottom-end" :options="audioMenuOptions" :value="playbackRate" @select="selectAudioAction">
                      <button type="button" class="audio-control-button" aria-label="录音播放选项" aria-haspopup="menu" title="录音播放选项">
                        <i class="iconfont icon-more" aria-hidden="true"></i>
                      </button>
                    </NDropdown>
                  </div>
                  <p v-else class="audio-note">播放地址已失效，请刷新页面重试。</p>
                </div>
              </div>
              <p v-else-if="audioStatusNote" class="audio-note">{{ audioStatusNote }}</p>
              <NButton v-if="['ready', 'partial'].includes(detail.audioStatus) && !detail.audioUrl" size="small" @click="selectMeeting(detail.sessionId)">刷新播放地址</NButton>
              <NButton v-if="detail.audioStatus === 'failed'" size="small" :disabled="!!currentAction" :loading="currentAction === 'audio'" @click="handleRetryAudio">重试保存音频</NButton>

              <div class="detail-tabs" role="group" aria-label="详情内容">
                <button type="button" :aria-pressed="activeTab === 'transcript'" @click="activeTab = 'transcript'">
                  转写文本
                </button>
                <button type="button" :aria-pressed="activeTab === 'summary'" @click="activeTab = 'summary'">
                  AI 纪要
                </button>
              </div>
              <MeetingTranscriptPlayback
                  v-if="activeTab === 'transcript'"
                  :segments="detail.transcriptJson"
                  :transcript="detail.transcript"
                  :position-ms="playbackPositionMs"
                  :seekable="audioPlayable && !audioFailed"
                  :loading="detail.generationStage === 'transcript' || currentAction === 'transcript'"
                  :regenerating="detail.regeneratingTranscript || currentAction === 'transcript'"
                  :can-regenerate="!activeRecording && (['ready', 'partial'].includes(detail.audioStatus) || detail.summaryError === 'final_transcript_failed')"
                  :regenerate-disabled="!!currentAction || detail.summaryStatus === 'generating'"
                  @seek="seekAudio"
                  @follow="followTranscript"
                  @regenerate="handleRegenerateTranscript"
                />
              <MeetingSummaryContent v-else :summary="detail.summary" :key-points="detail.keyPoints"
                :loading="detail.generationStage === 'summary' || currentAction === 'summary'"
                :waiting-for-transcript="detail.generationStage === 'transcript' || currentAction === 'transcript'"
                :can-regenerate="!activeRecording && !!detail.transcript.trim()"
                :regenerate-disabled="!!currentAction" @regenerate="handleGenerateSummary" />
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library-page {
  background: #f5f7fb;
  height: 100%;
  min-height: 0;
}
.library-columns {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 288px) minmax(0, 1fr);
  gap: 12px;
}
.library-sidebar,
.library-detail {
  min-width: 0;
  min-height: 0;
  border: 1px solid #eef1f6;
  border-radius: 12px;
  background: #fff;
}
.library-sidebar {
  display: flex;
  flex-direction: column;
}
.sidebar-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #eef1f6;
}
.sidebar-heading h2 {
  font-size: 14px;
  font-weight: 600;
}
.sidebar-heading-actions,
.batch-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.batch-toolbar { padding: 8px 12px; border-bottom: 1px solid #eef1f6; font-size: 12px; }
.batch-count { color: #667080; }
.sidebar-heading span,
.meeting-row-meta {
  color: #667080;
  font-size: 12px;
}
.library-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.meeting-items {
  list-style: none;
  display: grid;
  gap: 4px;
}
.meeting-list-item { display: flex; align-items: stretch; min-width: 0; }
.meeting-list-checkbox { align-self: center; flex: none; margin-inline: 6px; }
.meeting-row {
  width: 100%;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  display: grid;
  gap: 5px;
  text-align: left;
  cursor: pointer;
}
.meeting-row:hover {
  background: #f5f7fb;
}
.meeting-row:disabled { cursor: default; }
.meeting-row.is-selected {
  background: #edf5ff;
  border-color: #d5e6ff;
}
.meeting-row:focus-visible {
  outline: 2px solid #137fff;
  outline-offset: -2px;
}
.meeting-row-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meeting-row-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.pagination-bar {
  display: flex;
  justify-content: center;
  padding: 10px 8px;
  border-top: 1px solid #eef1f6;
}
.library-detail {
  overflow: auto;
}
.library-detail.has-recording {
  overflow: hidden;
}
.detail-body {
  --detail-padding: clamp(12px, 2.5vw, 28px);
  --detail-gap: 16px;
  --audio-surface: #f3f7fc;
  display: flex;
  flex-direction: column;
  gap: var(--detail-gap);
  min-height: 100%;
  padding: var(--detail-padding);
}
.meeting-status-label { display: inline-flex; align-items: center; gap: 4px; }
.detail-tabs {
  display: flex;
  gap: 18px;
  border-bottom: 1px solid #eef1f6;
}
.detail-tabs button {
  padding: 8px 2px;
  border-bottom: 2px solid transparent;
  font-size: 14px;
}
.detail-tabs button[aria-pressed='true'] {
  color: #137fff;
  border-color: currentColor;
  font-weight: 600;
}
.detail-tabs button:focus-visible {
  outline: 2px solid #137fff;
  outline-offset: -2px;
}
.detail-heading {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.detail-title {
  flex: 1 1 10rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-inline-start: auto;
}
.panel-state {
  display: grid;
  justify-items: center;
  align-content: center;
  min-height: 100px;
  height: 100%;
  padding: 12px;
}
@media (max-width: 680px) {
  .library-columns {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(112px, 34%) minmax(0, 1fr);
    gap: 8px;
  }
  .sidebar-heading {
    padding: 8px 12px;
  }
}
.title-input {
  min-width: 0;
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  font-size: 15px;
}
.audio-anchor {
  position: absolute;
  top: calc(100% + var(--detail-gap) - 1px);
  width: 1px;
  height: 1px;
  pointer-events: none;
}
.audio-sticky {
  position: sticky;
  top: 0;
  z-index: 1;
  margin-inline: calc(-1 * var(--detail-padding));
  padding-inline: var(--detail-padding);
  padding-block-end: 4px;
  margin-block-end: -4px;
}
.audio-sticky.is-stuck {
  background: var(--audio-surface);
}
.audio-player {
  min-width: 0;
  border: 1px solid #dce8f5;
  border-radius: 12px;
  padding: 2px 6px;
  background: var(--audio-surface);
}
.audio-sticky.is-stuck .audio-player:not(:focus-within) {
  border-color: transparent;
}
.audio-player:focus-within {
  border-color: #8bbcff;
}
.audio-controls {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: clamp(4px, 1vw, 12px);
  min-height: 44px;
  padding-inline: 2px;
}
.audio-control-button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 8px;
  color: #475569;
  cursor: pointer;
}
.audio-control-button:hover { background: #e2ecfa; }
.audio-play-button { color: #195fbd; background: #e2ecfa; }
.audio-control-button:focus-visible,
.audio-progress:focus-visible { outline: 2px solid #137fff; outline-offset: 2px; }
.audio-time { color: #475569; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.audio-progress {
  width: 100%;
  min-width: 0;
  height: 24px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.audio-progress:disabled { cursor: default; }
.audio-progress::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 4px;
  background: linear-gradient(to right, #4284da var(--audio-progress), #cfddec var(--audio-progress));
}
.audio-progress::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border-radius: 50%;
  background: #276fca;
}
.audio-progress::-moz-range-track { height: 4px; border-radius: 4px; background: #cfddec; }
.audio-progress::-moz-range-progress { height: 4px; border-radius: 4px; background: #4284da; }
.audio-progress::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #276fca; }
@media (pointer: coarse) {
  .audio-control-button { height: 44px; }
}
@media (max-width: 680px) {
  .audio-player {
    padding-inline: 2px;
  }
}
.audio-note {
  font-size: 12px;
  color: #667080;
  background: #f5f7fb;
  border-radius: 8px;
  padding: 8px 10px;
}
</style>
