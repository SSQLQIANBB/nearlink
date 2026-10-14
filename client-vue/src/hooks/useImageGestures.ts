import { ref, type Ref } from 'vue';

export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}
interface Point {
  x: number;
  y: number;
}

export function useImageGestures(
  target: Ref<HTMLElement | null>,
  options: {
    minScale: number;
    maxScale: number;
    enabled: () => boolean;
    constrain: (transform: ImageTransform) => ImageTransform;
  },
) {
  const transform = ref<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const pointers = new Map<number, Point>();

  function point(event: MouseEvent): Point {
    const rect = target.value!.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  }

  function update(ratio: number, from: Point, to: Point) {
    const current = transform.value;
    const scale = Math.max(options.minScale, Math.min(options.maxScale, current.scale * ratio));
    const factor = scale / current.scale;
    // 保持两指中点下的图像位置，缩放时允许同时平移。
    transform.value = options.constrain({
      scale,
      x: to.x - (from.x - current.x) * factor,
      y: to.y - (from.y - current.y) * factor,
    });
  }

  function pointerdown(event: PointerEvent) {
    if (!options.enabled() || event.button !== 0 || pointers.size >= 2) return;
    pointers.set(event.pointerId, point(event));
    target.value!.setPointerCapture(event.pointerId);
  }

  function pointermove(event: PointerEvent) {
    if (!options.enabled() || !pointers.has(event.pointerId)) return;
    const before = [...pointers.values()];
    pointers.set(event.pointerId, point(event));
    const after = [...pointers.values()];
    if (before.length === 1) {
      update(1, before[0]!, after[0]!);
      return;
    }
    const [a, b] = before as [Point, Point];
    const [c, d] = after as [Point, Point];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    // 两指重合时没有可用于计算缩放比例的距离。
    if (!distance) return;
    update(
      Math.hypot(c.x - d.x, c.y - d.y) / distance,
      { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 },
    );
  }

  function pointerend(event: PointerEvent) {
    pointers.delete(event.pointerId);
    if (target.value!.hasPointerCapture(event.pointerId))
      target.value!.releasePointerCapture(event.pointerId);
  }

  function wheel(event: WheelEvent) {
    event.preventDefault();
    if (!options.enabled()) return;
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.value!.clientHeight : 1);
    const focus = point(event);
    update(Math.exp(-delta * 0.002), focus, focus);
  }

  function reset() {
    pointers.clear();
    transform.value = { scale: 1, x: 0, y: 0 };
  }

  return {
    transform,
    reset,
    handlers: {
      pointerdown,
      pointermove,
      pointerup: pointerend,
      pointercancel: pointerend,
      lostpointercapture: pointerend,
      wheel,
    },
  };
}
