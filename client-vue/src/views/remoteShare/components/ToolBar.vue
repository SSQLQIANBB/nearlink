<template>
  <div class="call-toolbar">
    <n-button
      :disabled="!contactUser || calls.busy || mediaBusy"
      @click="start(1)"
    >
      <template #icon>
        <i
          class="iconfont call-action-icon icon-gongxiangpingmu"
          aria-hidden="true"
        ></i>
      </template>
      屏幕共享
    </n-button>
    <n-tooltip
      v-if="remote.showControllerEntry"
      :disabled="!remoteCapabilityHint"
    >
      <template #trigger>
        <span class="inline-flex">
          <n-button
            :disabled="!contactUser || calls.busy || mediaBusy || !remote.canControl"
            @click="openRemoteControl"
          >
            <template #icon>
              <i
                class="iconfont call-action-icon icon-desktop"
                aria-hidden="true"
              ></i>
            </template>
            远程控制
          </n-button>
        </span>
      </template>
      {{ remoteCapabilityHint }}
    </n-tooltip>
    <n-button
      :disabled="!contactUser || calls.busy || mediaBusy"
      @click="start(0)"
    >
      <template #icon>
        <i
          class="iconfont call-action-icon icon-video"
          aria-hidden="true"
        ></i>
      </template>
      视频通话
    </n-button>
    <n-button
      :disabled="!contactUser || calls.busy || mediaBusy"
      @click="start(2)"
    >
      <template #icon>
        <i
          class="iconfont call-action-icon icon-dianhua"
          aria-hidden="true"
        ></i>
      </template>
      语音通话
    </n-button>
  </div>
</template>
<script setup lang="ts">
import { NButton, NTooltip, useMessage } from 'naive-ui';
import { openScreenShare } from '@/features/screenShare';
const message = useMessage();
import { computed } from 'vue';
import { mediaOccupancy } from '@/services/mediaOccupancy';
const mediaBusy = computed(() => !!mediaOccupancy.current.value);
import { useRouter } from 'vue-router';
import { useRemoteControlStore } from '@/stores/remoteControl';
import { remoteCapabilityMessages } from '@/services/remoteControlCapabilities';
import { usePrivateCallStore, type CallUser } from '@/stores/privateCall';
const props = defineProps<{ contactUser: CallUser | null }>();
const calls = usePrivateCallStore();
const remote = useRemoteControlStore();
const remoteCapabilityHint = computed(() =>
  !remote.loading && remote.capabilities && !remote.capabilities.canControl
    ? remoteCapabilityMessages[remote.capabilities.reason]
    : '',
);
const router = useRouter();
function openRemoteControl() {
  if (props.contactUser && remote.canControl && !calls.busy && !mediaBusy.value) {
    void router.push({ name: 'RemoteControl', query: { userId: props.contactUser.id } });
  }
}
function start(type: 0 | 1 | 2) {
  if (!props.contactUser || mediaBusy.value) return;
  if (type === 1) {
    void openScreenShare({ kind: 'private', peerId: props.contactUser.id }, router).catch(
      (error) => {
        if (error.name !== 'NotAllowedError') message.error(error.message);
      },
    );
  } else calls.request = { user: props.contactUser, type };
}
</script>
