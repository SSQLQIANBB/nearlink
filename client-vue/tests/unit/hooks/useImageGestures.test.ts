import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useImageGestures } from '../../../src/hooks/useImageGestures';

function setup(minScale = 1) {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
  element.setPointerCapture = vi.fn();
  element.hasPointerCapture = () => false;
  const enabled = ref(true);
  const gestures = useImageGestures(ref(element), {
    minScale,
    maxScale: 3,
    enabled: () => enabled.value,
    constrain: (value) => value,
  });
  const event = (pointerId: number, x: number, y = 150) =>
    ({ pointerId, clientX: x, clientY: y, button: 0 }) as PointerEvent;
  return { ...gestures, enabled, event };
}

describe('图片手势', () => {
  it('头像可缩小至初始尺寸的四分之一，并可继续放大', () => {
    const { handlers, transform, event } = setup(0.25);
    handlers.pointerdown(event(1, 50));
    handlers.pointerdown(event(2, 250));
    handlers.pointermove(event(2, 100));
    expect(transform.value.scale).toBe(0.25);
    handlers.pointermove(event(2, 75));
    expect(transform.value.scale).toBe(0.25);
    handlers.pointermove(event(2, 100));
    expect(transform.value.scale).toBe(0.5);
  });

  it('围绕双指中点缩放，抬起一指后继续拖动不会跳位', () => {
    const { handlers, transform, event } = setup();
    handlers.pointerdown(event(1, 100));
    handlers.pointerdown(event(2, 200));
    handlers.pointermove(event(1, 50));
    handlers.pointermove(event(2, 250));
    expect(transform.value).toEqual({ scale: 2, x: 0, y: 0 });
    handlers.pointerup(event(2, 250));
    handlers.pointermove(event(1, 70));
    expect(transform.value).toEqual({ scale: 2, x: 20, y: 0 });
  });

  it('取消或失去捕获后不再响应旧指针，新手势正常开始', () => {
    const { handlers, transform, event } = setup();
    handlers.pointerdown(event(1, 100));
    handlers.pointerdown(event(2, 200));
    handlers.pointercancel(event(1, 100));
    handlers.lostpointercapture(event(2, 200));
    handlers.pointermove(event(1, 50));
    expect(transform.value).toEqual({ scale: 1, x: 0, y: 0 });
    handlers.pointerdown(event(3, 100));
    handlers.pointermove(event(3, 120));
    expect(transform.value.x).toBe(20);
  });

  it('第三根手指不打断双指缩放，缩放限制在允许范围', () => {
    const { handlers, transform, event } = setup();
    handlers.pointerdown(event(1, 100));
    handlers.pointerdown(event(2, 200));
    handlers.pointerdown(event(3, 220));
    handlers.pointermove(event(3, 280));
    expect(transform.value.scale).toBe(1);
    handlers.pointermove(event(2, 500));
    expect(transform.value.scale).toBe(3);
    handlers.pointermove(event(2, 110));
    expect(transform.value.scale).toBe(1);
  });

  it('滚轮围绕光标缩放，上传期间禁用手势', () => {
    const { handlers, transform, enabled, event } = setup();
    handlers.wheel({
      ...event(1, 200),
      deltaY: -Math.log(2) / 0.002,
      deltaMode: 0,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent);
    expect(transform.value).toEqual({ scale: 2, x: -50, y: 0 });
    handlers.pointerdown(event(1, 100));
    enabled.value = false;
    handlers.pointermove(event(1, 200));
    expect(transform.value.x).toBe(-50);
  });
});
