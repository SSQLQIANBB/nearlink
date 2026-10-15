import { mediaOccupancy } from './mediaOccupancy';
const captured = new Map<number | string, MediaStream>();

// 在用户点击按钮的手势内申请屏幕，跨路由交给共享页使用。
export async function captureGroupScreen(groupId: number | string) {
  const claim = mediaOccupancy.acquire('group-screen', `group-screen:${groupId}`, () =>
    discardCapturedGroupScreen(groupId),
  );
  if (!claim) throw new Error('请先结束当前通话或远程控制');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (error) {
    claim.release();
    throw error;
  }
  if (!claim.isCurrent()) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('共享已取消');
  }
  captured
    .get(groupId)
    ?.getTracks()
    .forEach((track) => track.stop());
  captured.set(groupId, stream);
  return stream;
}
export function takeCapturedGroupScreen(groupId: number | string) {
  const stream = captured.get(groupId) || null;
  captured.delete(groupId);
  return stream;
}
export function discardCapturedGroupScreen(groupId: number | string) {
  takeCapturedGroupScreen(groupId)
    ?.getTracks()
    .forEach((track) => track.stop());
  if (mediaOccupancy.current.value?.owner === `group-screen:${groupId}`)
    mediaOccupancy.stop('SCREEN_CAPTURE_CANCELLED');
}
