import Router from 'koa-router';
import { getDesktopRelease } from '../services/desktopRelease';
const router = new Router({ prefix: '/api/desktop' });
router.get('/release', async (ctx) => {
  try {
    ctx.body = { release: await getDesktopRelease() };
    ctx.set('Cache-Control', 'public, max-age=60');
  } catch {
    ctx.status = 503;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { message: '暂时无法获取桌面版本，请稍后重试。' };
  }
});
export default router;
