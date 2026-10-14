import { expect, test } from '@playwright/test';

test('背景分割模型能从项目资源加载并处理真实浏览器画布', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSegmenter, composeBackground } = await import(
      /* @vite-ignore */ '/src/services/backgroundProcessor.ts'
    );
    const segmenter = await createSegmenter();
    const source = document.createElement('canvas');
    source.width = 256;
    source.height = 144;
    source.getContext('2d')!.fillRect(0, 0, 256, 144);
    const output = document.createElement('canvas');
    output.width = 256;
    output.height = 144;
    let frames = 0;
    segmenter.onResults((results: any) => {
      frames++;
      composeBackground(output.getContext('2d')!, results, 256, 144, {
        effect: 'color',
        color: '#FF0000',
        image: null,
      });
    });
    await segmenter.send({ image: source });
    const pixel = [...output.getContext('2d')!.getImageData(0, 0, 1, 1).data];
    await segmenter.close();
    return { frames, pixel };
  });
  expect(result.frames).toBe(1);
  expect(result.pixel[0]).toBeGreaterThan(100);
  expect(result.pixel[3]).toBe(255);
});
