import { ref, onUnmounted, type Ref } from 'vue';
import { Socket, io, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { publicEnv } from '@/config/env';

// 定义连接状态枚举
export enum SocketStatus {
  Disconnected = 'disconnected', // 未连接
  Connecting = 'connecting', // 连接中
  Connected = 'connected', // 已连接
  Error = 'error', // 错误
}

export default function useSocket(
  // 可选：默认连接配置（可在 connect 时覆盖）
  defaultOptions: {
    url?: string;
    managerOptions?: Partial<ManagerOptions>;
    socketOptions?: Partial<SocketOptions>;
  } = {},
) {
  // 响应式状态（使用枚举类型约束）
  const socket: Ref<Socket | null> = ref(null);
  const status: Ref<SocketStatus> = ref(SocketStatus.Disconnected); // 初始状态：未连接
  const error: Ref<Error | null> = ref(null); // 错误信息
  const message: Ref<{ event: string; data: any } | null> = ref(null); // 最近收到的消息

  // 连接方法（支持动态传入配置覆盖默认值）
  function connect(
    customOptions: {
      url?: string;
      managerOptions?: Partial<ManagerOptions>;
      socketOptions?: Partial<SocketOptions>;
    } = {},
  ) {
    // 避免重复连接（使用枚举成员判断）
    if (status.value === SocketStatus.Connecting || status.value === SocketStatus.Connected) return;

    // 合并配置（自定义配置优先级更高）
    const url =
      customOptions.url || defaultOptions.url || publicEnv.socketUrl || window.location.origin;
    const managerOptions = { ...defaultOptions.managerOptions, ...customOptions.managerOptions };
    const socketOptions = {
      path: '/connect', // 默认路径（可被覆盖）
      ...defaultOptions.socketOptions,
      ...customOptions.socketOptions,
    };

    // 更新状态为连接中（使用枚举成员）
    status.value = SocketStatus.Connecting;
    error.value = null;

    // 创建 socket 实例
    socket.value = io(url, { ...managerOptions, ...socketOptions });

    // 监听连接成功
    socket.value.on('connect', () => {
      status.value = SocketStatus.Connected; // 更新为已连接

      send('ready');
      console.log('Socket connected successfully');
    });

    // 监听连接断开
    socket.value.on('disconnect', (reason) => {
      status.value = SocketStatus.Disconnected; // 更新为未连接
      console.log(`Socket disconnected: ${reason}`);
      // 如果是意外断开，尝试重连（依赖 socket.io 内置重连机制）
      if (reason === 'io server disconnect') {
        socket.value?.connect(); // 主动重连
      }
    });

    // 监听错误
    socket.value.on('error', (err) => {
      status.value = SocketStatus.Error; // 更新为错误状态
      error.value = err as Error;
      console.error('Socket error:', err);
    });

    // 监听所有自定义消息（统一转发到 message 状态）
    socket.value.onAny((event, data) => {
      message.value = { event, data };
      console.log(`Received message [${event}]:`, data);
    });
  }

  // 断开连接
  function disconnect() {
    if (socket.value) {
      socket.value.disconnect();
      socket.value.removeAllListeners(); // 清理所有监听器
      socket.value = null;
      status.value = SocketStatus.Disconnected; // 重置为未连接
      console.log('Socket disconnected manually');
    }
  }

  // 发送消息
  function send(event: string, data?: any) {
    // 检查连接状态（使用枚举成员判断）
    if (!socket.value || status.value !== SocketStatus.Connected) {
      console.error('Cannot send message: Socket is not connected');
      return false;
    }
    socket.value.emit(event, data);
    return true;
  }

  // 组件卸载时自动断开连接（避免内存泄漏）
  onUnmounted(() => {
    disconnect();
  });

  // 暴露给组件的状态和方法
  return {
    socket,
    status, // 类型为 SocketStatus 枚举
    error,
    message,
    connect,
    disconnect,
    send,
    SocketStatus, // 导出枚举，方便组件中直接使用（如判断状态）
  };
}
