import { Context, Next } from 'koa';

export default async function cors(ctx: Context, next: Next) {
  // 设置 CORS 响应头
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  ctx.set('Access-Control-Allow-Credentials', 'true');
  
  // 处理预检请求
  if (ctx.method === 'OPTIONS') {
    ctx.status = 200;
    return;
  }

  await next();
}