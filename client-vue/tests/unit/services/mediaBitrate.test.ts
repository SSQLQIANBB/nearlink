import { describe, expect, it, vi } from 'vitest';
import { limitVideoBitrate } from '@/services/mediaBitrate';

describe('video sender quality', () => {
  function sender(contentHint = 'detail') {
    return {
      track: { kind: 'video', contentHint },
      getParameters: () => ({ encodings: [{ active: true }] }),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('preserves resolution for desktop text sharing and raises the bitrate ceiling', async () => {
    const video = sender();
    await limitVideoBitrate(video as unknown as RTCRtpSender, 1_800_000, true);
    expect(video.setParameters).toHaveBeenCalledWith({
      encodings: [{ active: true, maxBitrate: 8_000_000 }],
      degradationPreference: 'maintain-resolution',
    });
  });

  it('keeps desktop smooth mode focused on frame rate', async () => {
    const video = sender('motion');
    await limitVideoBitrate(video as unknown as RTCRtpSender, 1_800_000, true);
    expect(video.setParameters).toHaveBeenCalledWith(expect.objectContaining({
      degradationPreference: 'maintain-framerate',
    }));
  });

  it.each([900_000, 1_800_000])('preserves the existing web/camera limit %i', async (bitrate) => {
    const video = sender();
    await limitVideoBitrate(video as unknown as RTCRtpSender, bitrate);
    expect(video.setParameters).toHaveBeenCalledWith({
      encodings: [{ active: true, maxBitrate: bitrate }],
    });
  });
});
