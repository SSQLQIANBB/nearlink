# 项目文档

- [ToDesk 功能对标与实施路线](./plans/todesk-feature-roadmap-20260928/README.md)：官网 72 项功能逐项规划、16 个代码工作包、服务器配置、容量测算与分期验收。
- [远程控制功能规划](./plans/2026-09-25-remote-control-design.md)：v2 设计、分期和验收门槛；当前完成范围见[实施进度](./plans/2026-09-25-remote-control-implementation.md)及[M0 实测记录](./plans/2026-09-25-remote-control-m0-validation.md)，远控尚未开放。
- [远控签名与主控协议](./plans/2026-09-26-remote-control-wire-protocol.md)：签名格式、密钥配置、建连/短租约、主控适配器事件与原生集成边界。
- [原生设备身份与确认](./plans/2026-09-26-remote-control-native-identity.md)：设备登记/撤销/重建、系统凭据存储、原生同意窗口与编译时可信公钥配置。
- [原生监督与输入](./plans/2026-09-26-remote-control-native-supervisor.md)：原生会话监督、继承管道认证、媒体租约、macOS 输入执行器和开发验证边界。
- [原生启动与协商](./plans/2026-09-26-remote-control-host-transport.md)：启动前占用本地同意、固定建连期限、实际 DTLS 绑定和保留接收时间的消息队列。
- [远控 TURN 接入与核对](./remote-control-turn.md)：复用现有服务、会话短期凭据、原生签名配置及 UDP/TCP 强制中继实测。
- [画面布局与指针坐标](./plans/2026-09-26-remote-control-layout.md)：实际内容矩形、双层黑边、DPI/旋转、原生布局绑定与变化停止。
- [原生引擎候选包](./remote-control-engine-packaging.md)：固定依赖、包内加载、完整资源校验、本地打包与验收边界。
- [内测版本与桌面发布](./DESKTOP_RELEASE.md)：统一版本、重大变更升级规则、版本检查和安装包构建。
- [功能实现链路](./FEATURE_IMPLEMENTATION_GUIDE.md)：按功能查看前端页面、API/Socket、后端处理器和存储模型的对应关系。
- [小带宽实时通信方案](./LOW_BANDWIDTH_REALTIME.md)：消息可靠性、在线状态、媒体限速和监控的实现与边界。
- [邮箱验证配置](./EMAIL_VERIFICATION.md)：QQ 邮箱 SMTP 配置、验证码规则和上线检查。
- [七牛 Kodo、CDN 与证书自动同步](./QINIU_CDN_CERTIFICATE_AUTOMATION.md)：从 `uploads` 迁移、对象上传、私有签名，到 AliDNS、Caddy、CDN 证书自动续期和故障排查的完整步骤。
- [环境变量管理规范](./ENVIRONMENT_VARIABLES.md)：本地、测试、Docker 和生产环境的配置归属、加载、校验及密钥管理规则。
- [本地启动](../STARTUP.md) 与 [生产部署](../DEPLOYMENT.md)。

`plans/` 和 `superpowers/` 下是设计与实施过程记录；排查当前功能时以[功能实现链路](./FEATURE_IMPLEMENTATION_GUIDE.md)及其链接的源码为准。
