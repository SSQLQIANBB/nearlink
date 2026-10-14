import type { Locator, Page } from '@playwright/test';

export async function pinch(page: Page, target: Locator, from: number, to: number) {
  const box = (await target.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const points = (distance: number) => [
    { id: 1, x: box.x + box.width / 2 - distance / 2, y: box.y + box.height / 2 },
    { id: 2, x: box.x + box.width / 2 + distance / 2, y: box.y + box.height / 2 },
  ];
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: points(from),
    });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: points(from + ((to - from) * step) / 8),
      });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}
