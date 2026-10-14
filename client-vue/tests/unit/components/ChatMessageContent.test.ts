import { mount, shallowMount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { NImage } from 'naive-ui';
import ChatImageMessage from '../../../src/components/ChatImageMessage.vue';
import ChatVoiceMessage from '../../../src/components/ChatVoiceMessage.vue';
import ChatMessageContent from '../../../src/components/ChatMessageContent.vue';

vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn() }),
}));

const image = {
  url: 'https://files.example.com/photo.png',
  mimeType: 'image/png',
  fileName: 'photo.png',
};

const voice = {
  url: 'https://files.example.com/voice.webm',
  mimeType: 'audio/webm',
  durationSeconds: 8,
};

describe('聊天媒体消息', () => {
  it('图片保留 Naive UI 缩略图并使用手势预览，不渲染跳转链接', () => {
    const wrapper = shallowMount(ChatImageMessage, {
      props: { media: image, isMine: false },
    });

    expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.findComponent(NImage).props('src')).toBe(image.url);
    expect(wrapper.findComponent(NImage).props('previewDisabled')).toBe(true);
  });

  it('语音显示为消息气泡并可点击播放', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const wrapper = mount(ChatVoiceMessage, {
      props: { media: voice, isMine: true },
    });

    expect(wrapper.find('.chat-voice').classes()).toContain('chat-voice--mine');
    expect(wrapper.find('.chat-voice__duration').text()).toBe('8″');
    expect(wrapper.find('audio').attributes('controls')).toBeUndefined();
    await wrapper.find('.chat-voice').trigger('click');
    expect(play).toHaveBeenCalledOnce();
    await wrapper.find('audio').trigger('play');
    expect(wrapper.find('.chat-voice').classes()).toContain('chat-voice--playing');
    const audio = wrapper.find('audio').element;
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => {});
    await wrapper.find('.chat-voice').trigger('click');
    expect(pause).toHaveBeenCalledOnce();
    await wrapper.find('audio').trigger('pause');
    expect(wrapper.find('.chat-voice').classes()).not.toContain('chat-voice--playing');
    audio.currentTime = 8;
    await wrapper.find('audio').trigger('ended');
    expect(audio.currentTime).toBe(0);
    wrapper.unmount();
    vi.restoreAllMocks();
  });

  it('文本消息保留纯文本，不执行 HTML', () => {
    const wrapper = mount(ChatMessageContent, {
      props: { message: '<img src=x onerror=alert(1)>\n第二行', isMine: false },
    });
    expect(wrapper.find('.chat-text').text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.find('img').exists()).toBe(false);
  });
});
