import { PassThrough } from 'stream';
import Router from 'koa-router';
import { koaBody } from 'koa-body';

const router = new Router();

// 配置请求体解析中间件（只在需要的路由上使用）
const bodyParser = koaBody({
  multipart: true,
  formidable: {
    maxFileSize: 200 * 1024 * 1024,
  },
});

// 模拟 AI 回答的函数
function generateAIResponse(message: string): string {
  const responses = [
    `我理解你说的是"${message}"。让我来详细回答你的问题。`,
    `这是一个很好的问题！关于${message}，我有以下看法：`,
    `根据你提到的"${message}"，我建议你可以从以下几个方面考虑：`,
  ];

  const randomResponse = responses[Math.floor(Math.random() * responses.length)];

  // 添加一些额外的内容
  const additionalContent = [
    '首先，我们需要了解背景情况。',
    '其次，这个问题涉及到多个方面的考虑。',
    '第三，我们可以从实践角度来分析。',
    '最后，我建议你可以尝试不同的方法来解决这个问题。',
    '希望这些信息对你有帮助！如果还有其他问题，随时问我。',
  ];

  return randomResponse + '\n\n' + additionalContent.join('\n\n');
}

// POST 接口：接收消息并以 SSE 流式返回答案
router.post('/send', bodyParser, async (ctx) => {
  const { message } = ctx.request.body as { message: string };

  if (!message) {
    ctx.status = 400;
    ctx.body = { error: '消息不能为空' };
    return;
  }

  console.log('message:', message);

  ctx.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-BUffering': 'no', // 禁用nginx缓存
  });

  ctx.status = 200;

  const stream = new PassThrough();
  ctx.body = stream;

  stream.write(' : connect\n\n');

  // 模拟生成 AI 回答
  const aiResponse = generateAIResponse(message);
  const words = aiResponse.split('');

  // // 设置 SSE 响应头（必须在写入响应之前设置）
  // ctx.req.socket.setNoDelay(true);

  // // 逐字发送答案
  let index = 0;
  const interval = setInterval(() => {
    if (index < words.length) {
      const char = words[index];
      const data = `data: ${JSON.stringify({
        type: 'text',
        content: char,
        index: index,
        done: false,
      })}\n\n`;
      stream.write(data);
      index++;
    } else {
      // 发送完成消息
      stream.write(
        `data: ${JSON.stringify({
          type: 'done',
          content: '',
          done: true,
        })}\n\n`,
      );
      clearInterval(interval);

      // 延迟关闭流，确保最后的数据发送完成
      setTimeout(() => {
        stream.end();
      }, 100);
    }
  }, 30); // 每30毫秒发送一个字符，更快的速度

  // 处理客户端断开连接
  ctx.req.on('close', () => {
    clearInterval(interval);
    if (!stream.destroyed) {
      stream.end();
    }
  });
});

export default router;
