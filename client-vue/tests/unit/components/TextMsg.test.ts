import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TextMsg from '../../../src/components/TextMsg.vue';

describe('发送时保持输入焦点', () => {
  it('按下发送图标不会提前收起键盘，单次 click 只发送一次', async () => {
    const wrapper = mount(TextMsg, { props: { value: '第一条消息' }, attachTo: document.body });
    try {
      const editor = wrapper.get('[role="textbox"]').element as HTMLElement;
      editor.focus();
      await wrapper.get('.send-button i').trigger('pointerdown');
      expect(document.activeElement).toBe(editor);
      await wrapper.get('.send-button').trigger('mousedown');
      await wrapper.get('.send-button').trigger('click');
      expect(wrapper.emitted('send')).toEqual([['第一条消息']]);
      await wrapper.get('.send-button').trigger('click');
      expect(wrapper.emitted('send')).toHaveLength(1);
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(document.activeElement).not.toBe(editor);
    } finally {
      wrapper.unmount();
    }
  });
});
