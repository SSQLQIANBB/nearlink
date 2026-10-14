import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScreenAnnotation from '../../../src/components/ScreenAnnotation.vue';

const context = {
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  ellipse: vi.fn(),
  fillText: vi.fn(),
  lineTo: vi.fn(),
  moveTo: vi.fn(),
  rect: vi.fn(),
  restore: vi.fn(),
  save: vi.fn(),
  stroke: vi.fn(),
};

async function dispatchPointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
) {
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      clientX,
      clientY,
    }),
  );
  await nextTick();
}

describe('ScreenAnnotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
  });

  it('共享者完成绘制时发出 0 到 1 的相对坐标', async () => {
    const wrapper = mount(ScreenAnnotation, {
      props: {
        editable: true,
        actions: [],
        drafts: [],
        showToolbar: true,
      },
    });
    const canvas = wrapper.get('canvas');
    vi.spyOn(canvas.element, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    await dispatchPointer(canvas.element, 'pointerdown', 20, 20);
    await dispatchPointer(canvas.element, 'pointermove', 100, 50);
    await dispatchPointer(canvas.element, 'pointerup', 100, 50);

    expect(wrapper.emitted('complete')?.[0]?.[0]).toMatchObject({
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.5, y: 0.5 },
      ],
    });
  });

  it.each([
    ['圆形', 'circle'],
    ['直线', 'line'],
    ['矩形', 'rect'],
  ])('选择 %s 后输出可同步的 %s 标注及颜色线宽', async (label, tool) => {
    const Color = defineComponent({
      name: 'NColorPicker',
      emits: ['update:value'],
      template: `<button class="set-color" @click="$emit('update:value', '#00FF00')">颜色</button>`,
    });
    const Slider = defineComponent({
      name: 'NSlider',
      emits: ['update:value'],
      template: `<button class="set-width" @click="$emit('update:value', 10)">粗细</button>`,
    });
    const Popover = defineComponent({
      name: 'NPopover',
      template: '<div><slot name="trigger" /><slot /></div>',
    });
    const wrapper = mount(ScreenAnnotation, {
      props: { editable: true, actions: [], drafts: [], showToolbar: true },
      global: { components: { NColorPicker: Color, NSlider: Slider, NPopover: Popover } },
    });
    const canvas = wrapper.get('canvas');
    vi.spyOn(canvas.element, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const button = wrapper.findAll('n-button').find((item) => item.text().trim().endsWith(label));
    expect(button).toBeDefined();
    await button!.trigger('click');
    await wrapper.get('.set-color').trigger('click');
    await wrapper.get('.set-width').trigger('click');
    await dispatchPointer(canvas.element, 'pointerdown', 20, 20);
    await dispatchPointer(canvas.element, 'pointermove', 100, 50);
    await dispatchPointer(canvas.element, 'pointerup', 100, 50);
    expect(wrapper.emitted('complete')?.[0]?.[0]).toMatchObject({
      tool,
      color: '#00FF00',
      lineWidth: 0.05,
    });
    if (tool === 'circle') expect(context.ellipse).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('观看者画布不接收绘制操作', async () => {
    const wrapper = mount(ScreenAnnotation, {
      props: {
        editable: false,
        actions: [],
        drafts: [],
        showToolbar: false,
      },
    });

    const canvas = wrapper.get('canvas');
    await dispatchPointer(canvas.element, 'pointerdown', 20, 20);
    await dispatchPointer(canvas.element, 'pointerup', 30, 30);

    expect(wrapper.emitted('complete')).toBeUndefined();
    expect(wrapper.get('canvas').classes()).toContain('annotation-canvas--readonly');
  });

  it('工具栏可拖动且不越过视口边界，重新打开时恢复底部默认位置', async () => {
    const wrapper = mount(ScreenAnnotation, {
      props: { editable: true, actions: [], drafts: [], showToolbar: true },
    });
    const toolbar = wrapper.get('.annotation-toolbar');
    vi.spyOn(toolbar.element, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 600,
      width: 300,
      height: 180,
    } as DOMRect);
    await dispatchPointer(wrapper.get('.toolbar-header').element, 'pointerdown', 130, 620);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 }));
    await nextTick();
    expect((toolbar.element as HTMLElement).style.left).toBe('8px');
    expect((toolbar.element as HTMLElement).style.top).toBe('8px');
    window.dispatchEvent(new Event('pointerup'));
    await wrapper.setProps({ showToolbar: false });
    await wrapper.setProps({ showToolbar: true });
    expect((wrapper.get('.annotation-toolbar').element as HTMLElement).style.top).toBe('');
    wrapper.unmount();
  });

  it('组件卸载时移除窗口 resize 监听', () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(ScreenAnnotation, {
      props: {
        editable: false,
        actions: [],
        drafts: [],
      },
    });

    wrapper.unmount();

    expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
