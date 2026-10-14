import sseRouter from './sse';
import chatRouter from './chat';
import authRouter from './auth';
import groupRouter from './group';
import messageRouter from './message';
import invitationRouter from './invitation';
import fileRouter from './file';
import remoteControlRouter from './remoteControl';
import Router from 'koa-router';

const apiRouter = new Router({
  prefix: '/api',
});

// 注册各个子路由
apiRouter.use('/sse', sseRouter.routes(), sseRouter.allowedMethods());
apiRouter.use('/chat', chatRouter.routes(), chatRouter.allowedMethods());

function setupRouter(app) {
  // 注册路由
  app.use(authRouter.routes()).use(authRouter.allowedMethods());
  app.use(groupRouter.routes()).use(groupRouter.allowedMethods());
  app.use(messageRouter.routes()).use(messageRouter.allowedMethods());
  app.use(invitationRouter.routes()).use(invitationRouter.allowedMethods());
  app.use(fileRouter.routes()).use(fileRouter.allowedMethods());
  app.use(remoteControlRouter.routes()).use(remoteControlRouter.allowedMethods());
  app.use(apiRouter.routes()).use(apiRouter.allowedMethods());
}

export default setupRouter;
