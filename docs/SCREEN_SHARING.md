# 通用屏幕共享

个人和群组使用 `client-vue/src/features/screenShare`，不再通过个人视频通话组件共享屏幕。

```ts
import { openScreenShare } from '@/features/screenShare';

await openScreenShare({ kind: 'private', peerId: 42 }, router);
await openScreenShare({ kind: 'group', id: 7 }, router);
// 接受邀请只进入观看，不申请屏幕采集。
await openScreenShare({ kind: 'private', peerId: 42 }, router, false);
```

也可直接挂载模块导出的 `ScreenShare` 组件，传入 `scope`。页面负责占用媒体资源、申请权限、管理 P2P、标注、录制和退出；调用方不要另外建立 PeerConnection 或申请同一份媒体流。

## API 与会话范围

统一 Socket 请求：`screen_share { scope, action, payload }`。

操作包含 `state/start/join/leave/end/decline/offer/answer/ice/draft/complete/undo/clear/mic/controlMic`。服务端根据已认证用户计算范围，忽略 payload 中伪造的 groupId、type 和 deviceType。

- 群组：校验真实群成员资格，支持 1 对 N；退出观看不结束其他成员的共享。
- 个人：服务端生成双方用户 ID 排序后的范围 `private:<id>:<id>`，不创建数据库群组；只允许双方各一个端点加入。拒绝、观看方退出或断线会结束一对一共享。
- 共享会话沿用 Redis 原子创建、会话代次校验、房间成员校验及标注权限。会话内部 `groupId` 字段兼容旧协议，现在也可承载个人范围字符串；音视频群聊仍使用原协议。
- 服务端响应仍沿用 `group_call_*`、`group_webrtc_*` 和 `screen_annotation_*` 事件，个人和群组由同一组件消费。旧版群组客户端可继续使用原请求事件；旧版个人屏幕通话邀请会被新版拒绝，请双方升级。
- 个人共享历史写入个人聊天，群组共享历史写入群聊。

## 桌面与网页

桌面端使用同一独立窗口、原生共享源选择器及共享边框；网页端在路由页使用浏览器采集。个人与群组共用画质、麦克风、标注、录制和参与者界面。群组权限由群角色决定，个人共享的主持人是当前共享者。

本次包含服务端 API 调整，前后端需要一起发布。真实桌面与网页互通、录制文件和多接收端画质仍需设备联调，单元测试不能替代这些验收。

### 共享中切换清晰度

个人和群组共享共用质量配置。分享方在网页共享页或桌面悬浮工具条选择清晰度后，更新现有视频轨道的采集参数及所有发送端的编码参数，不发送 end/start，不重新选择共享源，也不关闭 P2P 或麦克风。桌面采集使用原 token，在后续帧更新分辨率上限和目标帧率；实际帧率受设备采集耗时和网络条件限制。观看方不提供发送清晰度设置。

桌面分享全屏时继续显示绿色边框和工具条；观看方继续在独立媒体窗口观看，不创建本地采集或共享边框。
