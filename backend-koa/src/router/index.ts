import desktopReleaseRouter from './desktopRelease';
import authRouter from './auth';
import groupRouter from './group';
import messageRouter from './message';
import invitationRouter from './invitation';
import fileRouter from './file';
import remoteControlRouter from './remoteControl';
import meetingRouter from './meeting';

function setupRouter(app) {
  app.use(desktopReleaseRouter.routes()).use(desktopReleaseRouter.allowedMethods());
  // 注册路由
  app.use(authRouter.routes()).use(authRouter.allowedMethods());
  app.use(groupRouter.routes()).use(groupRouter.allowedMethods());
  app.use(messageRouter.routes()).use(messageRouter.allowedMethods());
  app.use(invitationRouter.routes()).use(invitationRouter.allowedMethods());
  app.use(fileRouter.routes()).use(fileRouter.allowedMethods());
  app.use(remoteControlRouter.routes()).use(remoteControlRouter.allowedMethods());
  app.use(meetingRouter.routes()).use(meetingRouter.allowedMethods());
}

export default setupRouter;
