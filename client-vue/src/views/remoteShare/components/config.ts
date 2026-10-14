// 摄像头约束配置
export const cameraConstraints = {
  audio: true, // 启用音频
  video: {
    width: { ideal: 960, max: 1280 },
    height: { ideal: 540, max: 720 },
    frameRate: { ideal: 24, max: 30 }, // 帧率
    facingMode: 'user', // 使用前置摄像头
  },
};

// 屏幕共享约束配置
export const screenRecordConstraints = {
  video: {
    cursor: 'always', // 始终显示鼠标光标
    displaySurface: 'monitor', // 'monitor' | 'window' | 'browser'
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 15, max: 24 },
  },
  audio: {
    echoCancellation: true, // 回声消除
    noiseSuppression: true, // 噪声抑制
    autoGainControl: true, // 自动增益控制
  },
};
