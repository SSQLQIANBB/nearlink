import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';
import { NAvatar } from 'naive-ui';
import { describe, expect, it } from 'vitest';

describe('list avatar fallback', () => {
  it.each([
    ['remoteShare/index.vue', 'user', '林'],
    ['groups.vue', 'group', '研'],
    ['groupChat.vue', 'member', '林'],
  ])(
    '%s recovers from a failed image without changing avatar data',
    async (file, variable, initial) => {
      const source = readFileSync(`src/views/${file}`, 'utf8');
      const template = [...source.matchAll(/<n-avatar\b[\s\S]*?<\/n-avatar>/g)]
        .map(([block]) => block)
        .find((block) => block.includes(`:src="${variable}.avatar || undefined"`));
      expect(template).toBeDefined();
      const entity = reactive({
        avatar: '/broken.png',
        nickname: '林晓',
        username: 'lin',
        name: '研发组',
      });
      const wrapper = mount(
        defineComponent({
          components: { NAvatar },
          template,
          setup: () => ({ [variable]: entity }),
        }),
      );
      try {
        expect(wrapper.find('img').attributes('src')).toBe('/broken.png');
        await wrapper.get('img').trigger('error');
        expect(wrapper.text()).toBe(initial);
        expect(wrapper.find('img').exists()).toBe(false);
        expect(entity.avatar).toBe('/broken.png');

        entity.avatar = '/updated.png';
        await nextTick();
        expect(wrapper.get('img').attributes('src')).toBe('/updated.png');
        await wrapper.get('img').trigger('load');
        expect(wrapper.text()).toBe('');

        entity.avatar = '';
        await nextTick();
        expect(wrapper.text()).toBe(initial);
      } finally {
        wrapper.unmount();
      }
    },
  );
});
