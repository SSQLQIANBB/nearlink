# sycsq.top / 本地 ToDesk 增量 UI 设计 v2

设计基线：本地 master `221993e`，产品版本 `0.5.0-beta.13`。不改产品版本、不修改生产功能。

本稿替代旧的独立远控工作台方向。实际网站重新加载遇到网络错误；页面结构和样式依本地源码核对。保留 `/remote` 联系人/群组、320px 侧栏、1152px 网页卡片、蓝白配色和底部四项工具栏；桌面沿用全窗口布局。

## 使用

打开 index.html 查看可点击原型；图片内按钮和功能表行可跳转。蓝湖上传为静态 UI/交互图，不等于已制作蓝湖原生热点原型。示例人名、设备、数据均为虚构。

## 代码映射

- 聊天：client-vue/src/views/remoteShare/index.vue 及 components/ToolBar.vue
- 个人中心：client-vue/src/views/profile.vue，RemoteDeviceSettings.vue，RemoteHostSettings.vue
- 远控：views/remoteControl/index.vue，components/GlobalRemoteControl.vue
- 桌面布局：client-vue/src/style/desktop.css；移动沿用现有联系人抽屉。

## 交互约束

- 入口按环境和实测能力开放；通用发布包不因设计图显示而获得原生被控引擎。
- 本机登记、协助许可、会话允许是三件事。长期许可不等于无条件控制；记住允许只覆盖已明确同意范围。
- 仅观看不显示“操作已暂停”；离焦或输入授权问题只暂停输入，真正断开单独显示原因。
- 每次跨功能权限升级需核对真实范围；文件、剪贴板、外设、录像分别授权。
- 多屏/手机/安卓/运维/隐私等规划必须经过平台实现及验收后开放。
- 每个异步面板均需空态、加载、成功、拒绝、失败重试；离线和能力缺失说明原因。
- 高影响操作显示目标、范围、后果并确认，权限撤销失败不可假报成功。

## 72 项覆盖表

|编号|类别|功能|当前状态|设计页|源码基点（不表示功能已实现）|
|---|---|---|---|---|---|
|01|基础远程控制|跨平台连接|部分：Web→macOS；其他平台待验收|01 现有远控页与等待状态|client-vue/src/views/remoteControl/index.vue|
|02|基础远程控制|浏览器发起连接|已有主控链路；按实际能力开放|01 现有远控页与等待状态|client-vue/src/views/remoteControl/index.vue|
|03|基础远程控制|电视投屏|规划：未验证当前项目具备该能力|14 移动端安卓电视投屏|client-vue/src/views/remoteShare/index.vue|
|04|基础远程控制|多显示器查看与切换|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|05|基础远程控制|分辨率适配与缩放|部分：现有画面适配；选择项待补|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|06|基础远程控制|隐藏桌面壁纸|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|07|基础远程控制|手机触控与虚拟鼠标|规划：未验证当前项目具备该能力|14 移动端安卓电视投屏|client-vue/src/views/remoteShare/index.vue|
|08|基础远程控制|安卓设备控制|规划：未验证当前项目具备该能力|14 移动端安卓电视投屏|client-vue/src/views/remoteShare/index.vue|
|09|基础远程控制|多标签会话|规划：未验证当前项目具备该能力|15 多会话与屏幕墙|client-vue/src/components/GlobalRemoteControl.vue|
|10|基础远程控制|仅观看|已有：明确区分查看与控制|04 仅观看会话|client-vue/src/components/GlobalRemoteControl.vue|
|11|基础远程控制|远程摄像头|规划：未验证当前项目具备该能力|09 聊天通话与协作|client-vue/src/components/ScreenAnnotation.vue|
|12|基础远程控制|多会话切换|规划：未验证当前项目具备该能力|15 多会话与屏幕墙|client-vue/src/components/GlobalRemoteControl.vue|
|13|基础远程控制|消息通知|部分：聊天已有；远控状态需补|00 现有聊天页增量入口|client-vue/src/views/remoteShare/index.vue|
|14|基础远程控制|设备别名|部分：登记时命名；编辑待补|10 现有个人中心设备管理|client-vue/src/components/RemoteDeviceSettings.vue|
|15|基础远程控制|同账号免密连接|部分：许可与记住允许；非无条件免密|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|16|基础远程控制|防止休眠|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|17|基础远程控制|网络代理|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|18|网络与画质|SD-WAN加速|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|19|网络与画质|全球节点加速|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|20|网络与画质|低延迟传输|部分：WebRTC/TURN；性能待验收|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|21|网络与画质|鼠标响应优化|部分：已有输入链路；优化待验收|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|22|网络与画质|高清与真彩/HDR|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|23|网络与画质|高帧率与垂直同步|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|24|网络与画质|性能模式切换|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|25|网络与画质|带宽限额|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|26|网络与画质|高延迟时暂停输入|部分：已有安全暂停；阈值策略待补|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|27|远程协作|跨平台文件传输|规划：未验证当前项目具备该能力|08 文件剪贴板与打印|client-vue/src/components/ChatMediaComposer.vue|
|28|远程协作|双向剪贴板|规划：未验证当前项目具备该能力|08 文件剪贴板与打印|client-vue/src/components/ChatMediaComposer.vue|
|29|远程协作|文字与语音交流|部分：聊天/通话已有；并发需验收|09 聊天通话与协作|client-vue/src/components/ScreenAnnotation.vue|
|30|远程协作|电脑向手机输入文字|规划：未验证当前项目具备该能力|14 移动端安卓电视投屏|client-vue/src/views/remoteShare/index.vue|
|31|远程协作|扩展屏与镜像屏|规划：未验证当前项目具备该能力|14 移动端安卓电视投屏|client-vue/src/views/remoteShare/index.vue|
|32|远程协作|虚拟显示器|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|33|远程协作|窗口共享|部分：屏幕共享已有；远控选择待补|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|34|远程协作|白板标注|部分：共享组件已有；远控整合待补|09 聊天通话与协作|client-vue/src/components/ScreenAnnotation.vue|
|35|远程协作|远程打印|规划：未验证当前项目具备该能力|08 文件剪贴板与打印|client-vue/src/components/ChatMediaComposer.vue|
|36|远程协作|多人同时控制|规划：未验证当前项目具备该能力|09 聊天通话与协作|client-vue/src/components/ScreenAnnotation.vue|
|37|远程协作|多光标协作|规划：未验证当前项目具备该能力|09 聊天通话与协作|client-vue/src/components/ScreenAnnotation.vue|
|38|远程协作|链接或协助码邀请|规划：未验证当前项目具备该能力|09 聊天通话与协作|client-vue/src/components/ScreenAnnotation.vue|
|39|远程协作|指定应用远控|规划：未验证当前项目具备该能力|07 画面与网络画质|client-vue/src/components/GlobalRemoteControl.vue|
|40|外设映射|游戏鼠标|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|41|外设映射|手机虚拟游戏键盘|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|42|外设映射|3D鼠标|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|43|外设映射|游戏手柄|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|44|外设映射|数位板与压感笔|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|45|外设映射|摄像头与麦克风|部分：通话已有；外设映射未实现|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|46|外设映射|自定义快捷键及键盘适配|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|47|外设映射|加密狗与U盾|规划：未验证当前项目具备该能力|13 外设映射面板|client-vue/src/components/GlobalPrivateCall.vue|
|48|设备与运维|无人值守连接|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|49|设备与运维|远程开关机/重启/锁屏|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|50|设备与运维|系统快捷操作|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|51|设备与运维|设备列表与分组|部分：设备列表已有；分组待补|10 现有个人中心设备管理|client-vue/src/components/RemoteDeviceSettings.vue|
|52|设备与运维|按设备保存设置|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|53|设备与运维|启动应用与远程更新|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|54|设备与运维|上下线提醒|规划：未验证当前项目具备该能力|10 现有个人中心设备管理|client-vue/src/components/RemoteDeviceSettings.vue|
|55|设备与运维|硬件信息|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|56|设备与运维|诊断日志|部分：工程日志已有；用户界面待补|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|57|设备与运维|多设备屏幕墙|规划：未验证当前项目具备该能力|15 多会话与屏幕墙|client-vue/src/components/GlobalRemoteControl.vue|
|58|设备与运维|批量分发文件|规划：未验证当前项目具备该能力|08 文件剪贴板与打印|client-vue/src/components/ChatMediaComposer.vue|
|59|设备与运维|CMD/SSH终端|规划：未验证当前项目具备该能力|11 设备运维详情|client-vue/src/components/RemoteDeviceSettings.vue|
|60|安全与隐私|传输加密|已有协议基础；安全整体仍需验收|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|61|安全与隐私|访问黑白名单|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|62|安全与隐私|连接权限策略|部分：许可/范围/撤销已有|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|63|安全与隐私|系统密码验证与解锁|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|64|安全与隐私|临时密码轮换|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|65|安全与隐私|二次验证|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|66|安全与隐私|隐私黑屏|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|67|安全与隐私|客户端锁定|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|68|安全与隐私|结束远控后锁屏|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|69|安全与隐私|禁用本地键鼠与锁定光标|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|70|安全与隐私|AI操作审计|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|71|安全与隐私|同账号控制状态提示|部分：会话状态已有；跨端提示待补|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|
|72|安全与隐私|会话录像|规划：未验证当前项目具备该能力|12 账户安全远控隐私|client-vue/src/components/RemoteHostSettings.vue|

## 蓝湖交付记录

23 张图已上传并核对文件列表，分组：**sycsq 现有页面增量设计 v2 · 72项功能**。旧分组已改名为“旧稿 v1 · 已被 sycsq 增量设计 v2 替代”。

[蓝湖新版首图](https://lanhuapp.com/web/#/item/project/detailDetach?tid=c8029f19-b833-4fbb-96b1-f6c6dd4c148a&pid=62dbfa8c-088f-4700-b3e1-3319953c1d3b&project_id=62dbfa8c-088f-4700-b3e1-3319953c1d3b&image_id=178f08ab-d89e-4a20-b7f4-5fdebc48d4b3&fromEditor=true&type=image)
