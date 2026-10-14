<template>
  <div class="call-toolbar flex gap-2 border-t p-3">
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
    <n-button
      v-if="remote.showControllerEntry"
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
import { NButton } from 'naive-ui';
import { computed } from 'vue';
import { mediaOccupancy } from '@/services/mediaOccupancy';
const mediaBusy = computed(() => !!mediaOccupancy.current.value);
import { useRouter } from 'vue-router';
import { useRemoteControlStore } from '@/stores/remoteControl';
import { usePrivateCallStore, type CallUser } from '@/stores/privateCall';
const props = defineProps<{ contactUser: CallUser | null }>();
const calls = usePrivateCallStore();
const remote = useRemoteControlStore();
const router = useRouter();
function openRemoteControl() {
  if (props.contactUser && remote.canControl && !calls.busy && !mediaBusy.value) {
    void router.push({ name: 'RemoteControl', query: { userId: props.contactUser.id } });
  }
}
function start(type: 0 | 1 | 2) {
  if (props.contactUser && !mediaBusy.value) calls.request = { user: props.contactUser, type };
}
</script>
