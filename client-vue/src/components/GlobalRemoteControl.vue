<template>
  <section v-if="session.visible" class="remote-session" :class="{ compact }" aria-label="远程协助会话">
    <header>
      <strong>{{ session.device?.alias || '远程协助' }}</strong>
      <span>{{ session.statusMessage }}</span>
      <n-button size="small" @click="minimize">{{ compact ? '展开' : '缩小' }}</n-button>
      <n-button size="small" type="error" @click="session.end()">结束协助</n-button>
    </header>
    <div ref="viewport" class="remote-video-area">
      <video ref="video" :style="videoStyle" @loadedmetadata="updateDimensions" @resize="updateDimensions" autoplay playsinline muted tabindex="0" :aria-label="session.scope === 'control' ? '远程画面，点击继续操作后可使用键盘鼠标' : '远程画面，仅观看'"
        @pointerdown="pointer($event, true)" @pointerup="pointer($event, false)" @pointermove="move"
        @lostpointercapture="captureLost" @pointercancel="pause" @wheel="wheel" @contextmenu.prevent
        @keydown="key($event, true)" @keyup="key($event, false)" @blur="pause" />
      <div v-if="!session.stream" class="waiting">{{ session.phase === 'pending' ? '等待对方在本机确认' : '正在建立安全连接' }}</div>
    </div>
    <footer v-if="!compact">
      <span>{{ session.scope === 'control' ? (session.inputArmed ? '键鼠操作中' : '键鼠操作已暂停') : '仅观看' }}</span>
      <n-button v-if="session.scope === 'control'" size="small" :disabled="session.phase !== 'active' || session.inputArmed" @click="session.continueInput()">继续操作</n-button>
      <n-button v-if="session.needsApproval && session.device?.canHostControl" size="small" @click="requestControl">请求控制许可</n-button>
      <n-button v-if="session.inputArmed" size="small" @click="pause">暂停操作</n-button>
      <label class="view-option">画面缩放
        <select :value="preferences.scale" aria-label="画面缩放" @focus="pause" @change="changeScale">
          <option value="fit">适应窗口</option><option value="50">50%</option><option value="100">原始大小（100%）</option><option value="150">150%</option><option value="200">200%</option>
        </select>
      </label>
      <label class="view-option"><input type="checkbox" :checked="preferences.showStats" @change="changeStats" />显示连接统计</label>
      <span v-if="preferenceNotice" role="status" class="hint">{{ preferenceNotice }}</span>
      <span v-if="session.stats && preferences.showStats" class="stats">{{ Math.round(session.stats.framesPerSecond) }} fps · {{ Math.round(session.stats.bitrate / 1000) }} kbps<span v-if="session.stats.roundTripMs !== null"> · RTT {{ Math.round(session.stats.roundTripMs) }} ms</span></span>
      <span v-if="session.scope === 'control'" class="hint">Esc 暂停操作；系统保留的快捷键仍由本机处理。</span>
      <form v-if="session.scope === 'control'" class="remote-text" @submit.prevent="sendText">
        <input v-model="text" maxlength="2048" aria-label="向远端输入文字" placeholder="输入中文或其他文字" @focus="pause" />
        <n-button size="small" attr-type="submit" :disabled="!text || sendingText || session.phase !== 'active'">发送文字</n-button>
      </form>
    </footer>
  </section>
  <aside v-else-if="session.failureCode" role="alert" class="remote-ended">
    <span>远程协助未能继续，已停止连接。错误代码：{{ session.failureCode }}</span>
    <n-button size="small" @click="session.failureCode = ''">关闭</n-button>
  </aside>
</template>
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { defaultRemoteViewPreferences, readRemoteViewPreferences, saveRemoteViewPreferences, remoteScales, type RemoteScale } from '@/services/remoteViewPreferences';
import { useRoute } from 'vue-router';
import { NButton } from 'naive-ui';
import { useRemoteControlSessionStore } from '@/stores/remoteControlSession';
import { remoteWheelPixels } from '@/services/remoteControlInput';
const session = useRemoteControlSessionStore();
const route = useRoute();
const auth = useAuthStore();
const preferences = ref(defaultRemoteViewPreferences());
const preferenceNotice = ref('');
const dimensions = ref({ width: 0, height: 0 });
const videoStyle = computed(() => {
  if (compact.value || preferences.value.scale === 'fit' || !dimensions.value.width || !dimensions.value.height) return {};
  const scale = Number(preferences.value.scale) / 100;
  return { width: `${dimensions.value.width * scale}px`, height: `${dimensions.value.height * scale}px`, maxWidth: 'none' };
});
function updateDimensions() {
  const width = video.value?.videoWidth || 0, height = video.value?.videoHeight || 0;
  if (width !== dimensions.value.width || height !== dimensions.value.height) pause();
  dimensions.value = { width, height };
}
function savePreferences() {
  pause();
  const userId = auth.currentUser?.id, deviceId = session.device?.deviceId;
  preferenceNotice.value = userId && deviceId && !auth.loggingOut && saveRemoteViewPreferences(userId, deviceId, preferences.value)
    ? '' : '当前设置已应用，但无法保存到本机。';
}
function changeScale(event: Event) {
  const scale = (event.target as HTMLSelectElement).value as RemoteScale;
  if (!remoteScales.includes(scale)) return;
  preferences.value = { ...preferences.value, scale }; savePreferences();
}
function changeStats(event: Event) { preferences.value = { ...preferences.value, showStats: (event.target as HTMLInputElement).checked }; savePreferences(); }
watch(() => [auth.currentUser?.id, auth.authGeneration, session.device?.deviceId, session.visible], () => {
  const userId = auth.currentUser?.id, deviceId = session.device?.deviceId;
  preferences.value = userId && deviceId && session.visible && !auth.loggingOut
    ? readRemoteViewPreferences(userId, deviceId) : defaultRemoteViewPreferences();
  preferenceNotice.value = '';
}, { immediate: true });
const video = ref<HTMLVideoElement | null>(null);
const viewport = ref<HTMLDivElement | null>(null);
const compact = ref(false);
const text = ref('');
const sendingText = ref(false);
const pressedPointers = new Set<number>();
watch(video, value => { dimensions.value = { width: value?.videoWidth || 0, height: value?.videoHeight || 0 }; session.attachVideo(value); }, { flush: 'post' });
watch(() => route.fullPath, () => pause());
function pause() { pressedPointers.clear(); session.pauseInput('CONTROLLER_VIEW_BLURRED'); }
function minimize() { pause(); compact.value = !compact.value; }
function position(event: MouseEvent) {
  const visible = viewport.value?.getBoundingClientRect();
  if (!visible || event.clientX < visible.left || event.clientX >= visible.right || event.clientY < visible.top || event.clientY >= visible.bottom) return null;
  return session.mapPointer(event.clientX, event.clientY);
}
function pointer(event: PointerEvent, down: boolean) {
  if (!session.inputArmed || ![0, 1, 2].includes(event.button)) return;
  const coordinates = position(event);
  if (!coordinates) { if (!down) pause(); return; }
  event.preventDefault();
  if (down) { pressedPointers.add(event.pointerId); video.value?.setPointerCapture(event.pointerId); }
  if (!session.sendInput({ type: 'button', payload: { ...coordinates, button: event.button as 0 | 1 | 2, down } })) pause();
  if (!down) { pressedPointers.delete(event.pointerId); if (video.value?.hasPointerCapture(event.pointerId)) video.value.releasePointerCapture(event.pointerId); }
}
function captureLost(event: PointerEvent) { if (pressedPointers.has(event.pointerId)) pause(); }
function move(event: PointerEvent) {
  if (!session.inputArmed) return;
  const coordinates = position(event);
  if (coordinates) session.sendInput({ type: 'move', payload: coordinates });
}
function wheel(event: WheelEvent) {
  if (!session.inputArmed) return;
  event.preventDefault();
  const coordinates = position(event);
  if (coordinates) session.sendInput({ type: 'wheel', payload: { ...coordinates, deltaX: remoteWheelPixels(event.deltaX, event.deltaMode, video.value?.clientHeight || 1), deltaY: remoteWheelPixels(event.deltaY, event.deltaMode, video.value?.clientHeight || 1), unit: 'css-pixel' } });
}
function key(event: KeyboardEvent, down: boolean) {
  if (event.code === 'Escape') { event.preventDefault(); pause(); return; }
  if (!session.inputArmed || event.isComposing) return;
  if (session.sendInput({ type: 'key', payload: { code: event.code, down } })) event.preventDefault();
}
async function sendText() {
  const value = text.value; sendingText.value = true;
  try { if (await session.commitText(value) && text.value === value) text.value = ''; }
  finally { sendingText.value = false; }
}
async function requestControl() { try { await session.requestControl(); } catch { /* The session transport already reports failure. */ } }
function visibility() { if (document.hidden) pause(); }
onMounted(() => { window.addEventListener('blur', pause); document.addEventListener('visibilitychange', visibility); });
onBeforeUnmount(() => { window.removeEventListener('blur', pause); document.removeEventListener('visibilitychange', visibility); session.attachVideo(null); session.end(); });
</script>
<style scoped>
.remote-ended { position: fixed; right: 20px; bottom: 20px; z-index: 2000; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 40px); padding: 16px; background: #fff7ed; color: #9a3412; border: 1px solid #fdba74; border-radius: 10px; }
.remote-session { position: fixed; z-index: 2000; inset: 6vh 5vw; display: flex; flex-direction: column; background: #111827; color: #e2e8f0; border: 1px solid #475569; border-radius: 12px; overflow: hidden; box-shadow: 0 15px 80px #0008; }
.remote-session.compact { inset: auto 20px 20px auto; width: min(520px, calc(100vw - 40px)); height: 340px; }
header, footer { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; background: #1e293b; }
header strong { flex: 1; }
header span, .hint, .stats { font-size: 12px; }
.remote-video-area { position: relative; flex: 1; min-height: 0; overflow: auto; }
video { display: block; width: 100%; height: 100%; object-fit: contain; outline: none; touch-action: none; }
video:focus { box-shadow: inset 0 0 0 2px #60a5fa; }
.waiting { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.remote-text { display: flex; width: 100%; gap: 8px; }
.remote-text input { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid #475569; border-radius: 6px; background: #111827; color: white; }
.view-option { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.view-option select { padding: 4px; color: #e2e8f0; background: #111827; border: 1px solid #64748b; border-radius: 4px; }
.hint { color: #94a3b8; }
</style>
