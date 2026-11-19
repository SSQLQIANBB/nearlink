<template>
  <div class="call-toolbar">
    <ComposerToolButton
      label="屏幕共享"
      :disabled="!contactUser || calls.busy || mediaBusy"
      @click="start(1)"
    >
      <i class="iconfont call-action-icon icon-gongxiangpingmu" aria-hidden="true"></i>
    </ComposerToolButton>
    <ComposerToolButton
      v-if="remote.showControllerEntry"
      label="远程控制"
      :hint="remoteCapabilityHint"
      :disabled="!contactUser || calls.busy || mediaBusy || !remote.canControl"
      @click="openRemoteControl"
    >
      <i class="iconfont call-action-icon icon-desktop" aria-hidden="true"></i>
    </ComposerToolButton>
    <ComposerToolButton
      label="视频通话"
      :disabled="!contactUser || calls.busy || mediaBusy"
      @click="start(0)"
    >
      <i class="iconfont call-action-icon icon-video" aria-hidden="true"></i>
    </ComposerToolButton>
    <ComposerToolButton
      label="语音通话"
      :disabled="!contactUser || calls.busy || mediaBusy"
      @click="start(2)"
    >
      <i class="iconfont call-action-icon icon-dianhua" aria-hidden="true"></i>
    </ComposerToolButton>
  </div>
</template>
<script setup lang="ts">
import { useMessage } from 'naive-ui';
import ComposerToolButton from '@/components/ComposerToolButton.vue';
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
