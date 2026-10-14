import { PassThrough } from 'stream';
import Router from 'koa-router';

const router = new Router();

router.get('/connect', (ctx) => {
  // 必须先设置状态码
  ctx.status = 200;

  // 设置 SSE 响应头
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const stream = new PassThrough();

  // 发送初始消息
  stream.write(': connected\n\n');

  // 定时发送消息
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      stream.write(`id: ${i}\n`);
      stream.write(
        `data: ${JSON.stringify({
          message: 'Update from server',
          count: i,
        })}\n`,
      );
      stream.write('\n');
    }, 1000 * i);
  }

  // 5秒后结束连接
  setTimeout(() => {
    stream.end();
  }, 6000);

  ctx.body = stream;
});

export default router;
