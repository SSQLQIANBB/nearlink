<template>
  <n-card
    class="socket-page"
    style="height: 100%"
    content-style="max-height: 100%; overflow: auto"
  >
    <template #header>
      <n-space>
        <n-button
          v-if="![SocketStatus.Connected, SocketStatus.Connecting].includes(status)"
          type="primary"
          @click="handleConnect"
        >
          connect socket
        </n-button>
        <n-space v-else>
          <n-button @click="disconnect">disconnect</n-button>
        </n-space>
        <n-button
          type="primary"
          @click="getMedia"
        >
          启用摄像头
        </n-button>
        <n-button
          type="primary"
          @click="getPicture"
        >
          拍照
        </n-button>
        <n-button
          type="primary"
          @click="shareScreenMedia"
        >
          屏幕共享
        </n-button>
      </n-space>
    </template>

    <n-form-item label="用户名">
      <n-input v-model:value="username" />
    </n-form-item>
    <n-form-item label="房间">
      <n-input v-model:value="roomId" />
    </n-form-item>
    <video
      ref="videoRef"
      autoplay
      playsinline
      class="media-preview"
    />
    <img
      ref="imgRef"
      class="media-preview"
    />
    <canvas
      style="visibility: hidden"
      ref="canvasRef"
    />

    <li
      v-for="user in userList"
      :key="user.userId"
      style="display: flex; justify-content: space-between"
    >
      <span>{{ user.username }}</span>
      <n-button
        :disabled="user.username === username"
        @click="localCaller(user.userId)"
        type="primary"
      >
        呼叫
      </n-button>
    </li>
  </n-card>
</template>

<script lang="ts" setup>
import useSocket, { SocketStatus } from '@/hooks/useSocket';
import { NButton, NSelect, useDialog, useMessage } from 'naive-ui';
import { h, ref } from 'vue';

const videoRef = ref<HTMLVideoElement | null>(null);

const imgRef = ref<HTMLImageElement | null>(null);

const canvasRef = ref<HTMLCanvasElement | null>(null);

const username = ref(null);
const roomId = ref(null);

const { socket, status, disconnect, connect } = useSocket();

const userList = ref<any>([]);
function handleConnect() {
  if (!username.value || !roomId.value) {
    message.warning('用户名和房间不可为空');

    return;
  }
  connect({
    managerOptions: {
      query: {
        username: username.value,
        roomId: roomId.value,
      },
    },
  });

  socket.value?.on('userList', (v) => {
    console.log('current-user-list', v);

    userList.value = v;
  });

  socket.value?.on('disconnect', () => {
    userList.value = [];
  });

  remoteCallee();
}

const dialog = useDialog();
const message = useMessage();

async function setDevice() {
  let resolve: any, reject: any;

  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });

  const devicesList: any[] = await navigator.mediaDevices?.enumerateDevices();

  for (const device of devicesList) {
    console.log(device);
  }

  if (!devicesList.length) return;
  else {
    let deviceId = '';
    const d = dialog.create({
      title: '请选择摄入设备',
      content: () =>
        h(NSelect, {
          options: devicesList.filter(({ deviceId }) => deviceId),
          valueField: 'deviceId',
          renderLabel: (opt: any) =>
            opt?.label ||
            (opt.kind === 'audiooutput'
              ? '音频输出'
              : opt.kind === 'audioinput'
                ? '音频输入'
                : 'unknown'),
          'onUpdate:value': (v) => {
            deviceId = v;
          },
        }),
      negativeText: '取消',
      positiveText: '确定',
      onPositiveClick: () => {
        if (!deviceId) {
          message.warning('请选择设备');
          return false;
        } else {
          resolve(deviceId);
          d.destroy();
        }
      },
      onNegativeClick: () => {
        reject(false);
      },
    });
  }

  return promise;
}
async function getMedia() {
  const deviceId = await setDevice();

  if (!deviceId) return;
  const constraints = {
    audio: false,
    video: {
      width: 1920,
      height: 1080,
      deviceId,
      frameRate: { ideal: 10, max: 15 }, // 帧率

      // facingMode: 'user' | 'environment' // 移动端 “前置” “后置”摄像头
      //#region 曝光控制
      exposureMode: 'continuous', // "manual" | "single-shot" | "continuous"
      exposureCompensation: 1.0, // 曝光补偿值 (-2.0 到 +2.0)
      exposureTime: 10000, // 曝光时间(微秒)，仅在manual模式下有效
      //#endregion

      //#region 对焦控制
      focusMode: 'continuous', // "manual" | "single-shot" | "continuous"
      focusDistance: 0.5, // 对焦距离 (0.0-1.0)，仅manual模式有效
      pointsOfInterest: [{ x: 0.5, y: 0.5 }], // 对焦点坐标 (归一化坐标)
      //#endregion

      //#region 图像质量控制
      brightness: 1, // 亮度 (-1.0 到 +1.0)
      contrast: 1, // 对比度 (-1.0 到 +1.0)
      saturation: 1, // 饱和度 (-1.0 到 +1.0)
      sharpness: 1, // 锐度 (0.0-1.0)
      colorTemperature: 6500, // 色温 (开尔文温度，如 6500K)
      whiteBalanceMode: 'continuous', // "manual" | "single-shot" | "continuous"
      //#endregion

      //#region 相机硬件控制
      iso: 100, // ISO感光度
      zoom: 10.0, // 数字缩放 (1.0为无缩放)
      torch: true, // 闪光灯控制
      pan: 180, // 水平旋转角度 (-180°到+180°)
      tilt: 90, // 垂直倾斜角度 (-180°到+180°)
      //#endregion
    },
  };

  const localStream = await navigator.mediaDevices.getUserMedia(constraints);

  videoRef.value!.srcObject = localStream;

  // videoRef.value!.onloadedmetadata = () => {
  //   videoRef.value?.play()
  // }
}

function getPicture() {
  clearPhoto();
  if (!canvasRef.value) return;

  const context = canvasRef.value.getContext('2d');

  canvasRef.value.width = 480;
  canvasRef.value.height = 270;

  context?.drawImage(videoRef.value!, 0, 0, 480, 270);

  const data = canvasRef.value?.toDataURL('image/png');

  imgRef.value?.setAttribute('src', data);
}

function clearPhoto() {
  const context = canvasRef.value?.getContext('2d');

  if (context) {
    context.fillStyle = '#aaa';
    context.fillRect(0, 0, canvasRef.value!.width, canvasRef.value!.height);

    const data = canvasRef.value?.toDataURL('image/png');

    if (data && imgRef.value) imgRef.value!.setAttribute('src', data);
  }
}

// 屏幕录制
function shareScreenMedia() {
  const constraints = {
    video: {
      displaySurface: 'browser', // monitor整个显示器屏幕 window单个应用程序窗口 browser 浏览器标签页
      width: 1920,
      height: 1080,
      resizeMode: 'none', // 视频流如何调整大小适应指定的尺寸约束：none不进行任何缩放, crop-and-scale裁剪并缩放到目标
    },
  };

  navigator.mediaDevices.getDisplayMedia(constraints).then((stream) => {
    console.log('share:', stream);
    videoRef.value!.srcObject = stream;

    stream.getTracks().forEach((track) => {
      peer.value?.addTrack(track, stream);
    });
  });
}

const peer = ref<RTCPeerConnection | null>(null);

// 发起方
async function localCaller(userId: any) {
  peer.value = new RTCPeerConnection();
  const offer = await peer.value?.createOffer();

  // 本地设置localDescription
  peer.value?.setLocalDescription(offer);

  socket.value?.emit('offer', { userId, offer });

  socket.value?.on('answer', async (answer) => {
    peer.value?.setRemoteDescription(answer);
  });

  peer.value!.onicecandidate = (event) => {
    if (event) socket.value?.emit('ice', { userId, candidate: event.candidate });
  };
}

// 被呼叫方
function remoteCallee() {
  peer.value = new RTCPeerConnection();
  socket.value?.on('offer', async ({ userId, offer }) => {
    peer.value?.setRemoteDescription(offer);

    const answer = await peer.value?.createAnswer();

    peer.value?.setLocalDescription(answer);

    socket.value?.emit('answer', { userId, answer });
  });

  socket.value!.on('ice', (candidate) => {
    peer.value?.addIceCandidate(candidate);
  });

  peer.value!.ontrack = (e) => {
    videoRef.value!.srcObject = e.streams[0] as any;
  };
}
</script>

<style scoped>
.socket-page {
  max-width: 100%;
  overflow-x: hidden;
}

.media-preview {
  display: block;
  width: min(480px, 100%);
  height: auto;
  aspect-ratio: 16 / 9;
  object-fit: contain;
}
</style>
