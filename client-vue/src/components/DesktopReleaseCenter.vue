<template>
  <aside
    v-if="hasUpdate && !releaseError && dismissedVersion !== release?.version && !releaseOpen"
    class="update-notice"
    aria-live="polite"
  >
    <div>
      <strong>NearLink 有新版本</strong>
      <p>内测版 {{ release?.version }} · 可稍后安装</p>
    </div>
    <n-button
      size="small"
      type="primary"
      @click="openDesktopRelease"
    >
      查看更新
    </n-button>
    <n-button
      size="small"
      quaternary
      aria-label="稍后提醒"
      @click="dismissedVersion = release?.version || ''"
    >
      稍后
    </n-button>
  </aside>
  <n-modal
    v-model:show="releaseOpen"
    preset="card"
    :title="desktop ? '桌面端更新' : '下载 NearLink 桌面端'"
    class="release-card"
    :style="{ width: '520px', maxWidth: 'calc(100vw - 24px)' }"
  >
    <div class="release-hero">
      <img
        src="/app-icon.png"
        alt=""
        width="48"
        height="48"
      />
      <div>
        <h2>
          NearLink
          <span>内测版</span>
        </h2>
        <p>{{ desktop ? `当前版本 ${installedVersion}` : '让协作留在桌面，随时保持连接' }}</p>
      </div>
    </div>
    <div
      v-if="releaseLoading"
      class="release-state"
      role="status"
    >
      <n-spin size="small" />
      正在获取已发布版本…
    </div>
    <div
      v-else-if="releaseError"
      class="release-state"
      role="alert"
    >
      <p>{{ releaseError }}</p>
      <n-button @click="checkDesktopRelease(true)">重新获取</n-button>
    </div>
    <div
      v-else-if="!release"
      class="release-state"
    >
      暂无可下载的完整安装包，请稍后再来。
    </div>
    <template v-else>
      <div class="release-version">
        <strong>
          {{ hasUpdate ? '可更新至' : desktop ? '已发布版本' : '最新已发布版本' }}
          {{ release.version }}
        </strong>
        <span v-if="desktop && !hasUpdate">当前无需更新</span>
      </div>
      <p class="release-hint">
        {{
          desktop
            ? '按当前客户端架构推荐安装包，也可手动选择。'
            : '已识别的 Windows 64 位电脑会自动选中；Mac 请在「关于本机」确认芯片。手机和其他系统请在对应电脑上安装。'
        }}
      </p>
      <div
        class="platform-options"
        role="group"
        aria-label="选择安装平台"
      >
        <button
          v-for="(label, key) in platformLabels"
          :key="key"
          type="button"
          :class="{ selected: selectedPlatform === key }"
          :aria-pressed="selectedPlatform === key"
          @click="selectedPlatform = key"
        >
          <span>{{ label }}</span>
          <span class="platform-size">
            {{ Math.ceil(release.assets[key].size / 1024 / 1024) }} MB
          </span>
        </button>
      </div>
      <div class="install-guide">
        <strong>{{ desktop ? '如何更新' : '安装说明' }}</strong>
        <p v-if="selectedPlatform === 'windows-x64'">
          下载安装包 → 结束通话与远控 → 从托盘退出 NearLink →
          运行安装程序，按提示完成安装并重新打开。
        </p>
        <p v-else-if="selectedPlatform">
          下载并打开 DMG → 结束通话与远控并退出 NearLink → 拖入「应用程序」替换旧版 → 重新打开。
        </p>
        <p v-else>请选择与你电脑系统和芯片对应的安装包。</p>
        <p>下载不会中断当前会话，不会自动安装或重启。远控能力以对应版本说明和实际支持为准。</p>
      </div>
      <n-button
        type="primary"
        block
        size="large"
        :disabled="!selectedPlatform || (desktop && !hasUpdate)"
        :loading="opening"
        @click="download"
      >
        {{ desktop ? '下载更新安装包' : '下载安装包' }}
      </n-button>
      <p
        v-if="downloadMessage"
        class="release-hint"
        role="status"
      >
        {{ downloadMessage }}
      </p>
    </template>
    <div class="release-footer">
      <span>仅提供已公开发布的安装包</span>
      <n-button
        v-if="release && !releaseError"
        text
        size="small"
        @click="showNotes"
      >
        版本说明
      </n-button>
      <n-button
        text
        size="small"
        :disabled="releaseLoading"
        @click="checkDesktopRelease(true)"
      >
        检查新版
      </n-button>
    </div>
  </n-modal>
</template>
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { NModal, NButton, NSpin } from 'naive-ui';
import {
  desktop,
  release,
  releaseOpen,
  releaseLoading,
  releaseError,
  selectedPlatform,
  installedVersion,
  dismissedVersion,
  hasUpdate,
  platformLabels,
  openDesktopRelease,
  checkDesktopRelease,
  downloadDesktopRelease,
  openDesktopReleaseNotes,
} from '@/services/desktopRelease';
async function showNotes() {
  try {
    await openDesktopReleaseNotes();
  } catch {
    downloadMessage.value = '无法打开版本说明，请稍后重试。';
  }
}
const opening = ref(false);
const downloadMessage = ref('');
async function download() {
  opening.value = true;
  downloadMessage.value = '';
  try {
    await downloadDesktopRelease();
    downloadMessage.value = desktop
      ? '已请求系统浏览器打开下载，请在浏览器中查看进度。'
      : '已打开下载链接，请在浏览器下载列表中查看进度。';
  } catch {
    downloadMessage.value = '无法打开下载，请稍后重试。';
  } finally {
    opening.value = false;
  }
}
const refresh = () => {
  if (desktop) void checkDesktopRelease();
};
onMounted(() => {
  refresh();
  window.addEventListener('focus', refresh);
});
onUnmounted(() => window.removeEventListener('focus', refresh));
</script>
<style scoped>
.release-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  background: #eff6ff;
  border: 1px solid #dbeafe;
  border-radius: 12px;
}
.release-hero img {
  border-radius: 12px;
}
.release-hero h2 {
  font-size: 20px;
  color: #1e293b;
  margin: 0;
}
.release-hero h2 span {
  display: inline-block;
  vertical-align: middle;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 6px;
  color: #2563eb;
  background: #dbeafe;
}
.release-hero p,
.release-hint {
  font-size: 12px;
  line-height: 1.7;
  color: #64748b;
  margin: 6px 0 0;
}
.release-version {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  margin-top: 22px;
  color: #334155;
}
.release-version span {
  font-size: 12px;
  color: #64748b;
}
.platform-options {
  display: grid;
  gap: 8px;
  margin: 16px 0;
}
.platform-options button {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 10px;
  color: #334155;
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.platform-options button:hover,
.platform-options button.selected {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}
.platform-options button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.platform-size {
  font-size: 12px;
  white-space: nowrap;
  color: #64748b;
}
.install-guide {
  background: #f8fafc;
  padding: 14px;
  border-radius: 10px;
  margin-bottom: 18px;
  color: #475569;
  font-size: 12px;
  line-height: 1.8;
}
.install-guide strong {
  color: #334155;
  font-size: 13px;
}
.install-guide p {
  margin: 6px 0 0;
}
.release-state {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 12px;
  padding: 30px 0;
  color: #64748b;
}
.release-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid #e2e8f0;
  margin-top: 20px;
  padding-top: 14px;
  color: #94a3b8;
  font-size: 11px;
}
.update-notice {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
  max-width: calc(100vw - 24px);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: #fff;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  box-shadow: 0 8px 28px #0f172a14;
  color: #334155;
}
.update-notice p {
  font-size: 12px;
  color: #64748b;
  margin: 3px 0 0;
}
@media (max-width: 540px) {
  .update-notice {
    right: 12px;
    bottom: 12px;
  }
}
</style>
