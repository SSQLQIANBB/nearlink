# Windows 与 macOS 桌面版

桌面客户端使用 Tauri 2（Windows 使用 WebView2，macOS 使用 WKWebView），内嵌现有 Vue 页面，连接现有 Koa / Socket.IO 服务。聊天、群组、音视频、屏幕共享、头像裁剪和账号通知偏好复用网页实现。

Windows 主窗口不显示独立系统标题栏，内容从窗口顶边开始，右上角保留最小化、最大化/还原、关闭按钮。标题空白区可拖动、双击切换最大化；关闭仍隐藏到托盘。窗口初始化仅在 Windows 移除装饰，macOS 的 Overlay 标题栏和原生红黄绿按钮保持原样。

Windows 任务栏使用主窗口的 `ICON_BIG`。当前 Tauri/Tao 的窗口图标设置只覆盖 `ICON_SMALL`，因此启动时从 EXE 中 tauri-build 的图标资源 32512 加载握手图标并设置大图标；使用 `LR_SHARED` 由系统管理生命周期。图标原图和 macOS ICNS 不变。原生测试检查无系统标题栏、任务栏大图标及窗口按钮行为；浏览器布局测试不能代替安装包实测。

## 已接入能力

- 桌面私聊与群聊铺满窗口可用内容区，无网页外层留白、最大宽度限制和卡片阴影。Mac 红黄绿按钮直接叠加在页面背景上，顶部仅有透明拖动热区，不显示独立横条、标题文字或分隔线；页面顶部操作避让窗口按钮，顶部可拖动及双击缩放；Windows 使用内容区右上角的窗口按钮，不显示系统标题栏。
- 原生窗口支持缩放、最小化和最大化，恢复上次窗口大小与位置。
- 关闭窗口隐藏到托盘，保留消息连接和正在进行的通话；点击托盘或重复启动返回现有窗口；托盘菜单“退出 NearLink”结束进程。
- 桌面系统通知复用账号级通知类型、内容预览和声音设置。切换到其他应用也视为后台，回到窗口后清除当前会话未读。
- 录制文件使用系统另存为对话框。取消保留录制内容，写入失败可重试；文件权限只授予用户所选路径。
- PNG/JPEG 头像通过系统文件选择器上传，20 MB 上限和裁剪流程与网页一致。
- NSIS 安装包按当前用户安装，无 WebView2 时下载安装运行时。

通知插件在 Windows 中需要安装后的应用才能显示正式名称和图标；系统通知点击跳转会话尚不支持，请通过托盘返回聊天。系统“请勿打扰”或禁用 NearLink 通知仍会影响提醒。参考 [Tauri 通知说明](https://v2.tauri.app/plugin/notification/)。

## Windows 构建环境

1. Windows 10/11 x64，Node.js 22，pnpm 10.14.0。
2. 安装 Visual Studio 2022 Build Tools，选择“使用 C++ 的桌面开发”，包含 MSVC 和 Windows 10/11 SDK。
3. 安装 Rust stable，默认工具链 `x86_64-pc-windows-msvc`，重开终端确保 `cargo`、`rustc` 在 PATH。
4. 安装 Microsoft Edge WebView2 Evergreen Runtime。

官方说明：[Windows 前置依赖](https://v2.tauri.app/start/prerequisites/#windows)。

## macOS 构建环境

- macOS 12 或更新版本；Node.js 22、pnpm 10.14.0、Rust stable。
- 安装 Xcode Command Line Tools：`xcode-select --install`。
- `pnpm desktop:build` 自动读取 `tauri.macos.conf.json`，生成 `.app` 和 `.dmg`，不再尝试构建 Windows NSIS。
- 本机构建使用当前 CPU 架构；CI 分别构建 Apple 芯片（aarch64）和 Intel（x64）版本。
- macOS 权限声明包含摄像头和麦克风用途；首次使用需授权。关闭窗口后可从 Dock 或菜单栏托盘的“打开 NearLink”恢复。
- 语音与通话录制按 WebView 支持情况选择 WebM 或 MP4，保存文件扩展名与实际内容一致。
- 目前采用 ad-hoc 临时签名，未完成 Developer ID 签名及 Apple 公证，下载后可能被 Gatekeeper 拦截；临时签名不等于 Apple 认证。
- 屏幕共享取决于系统 WKWebView 的捕获能力和系统权限；macOS 上游存在兼容性限制，不能将打包成功视为屏幕共享通过验收，参见 [Wry 跟踪问题](https://github.com/tauri-apps/wry/issues/1101)。

## 服务地址

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
Copy-Item client-vue/.env.desktop.example client-vue/.env.desktop
```

编辑 `.env.desktop`：

| 变量 | 要求 | 来源与用途 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 安装包构建必填；公开可分享 | 部署负责人提供的 API 站点根地址，不含 `/api`；本地联调可用 `http://localhost:3000` |
| `VITE_SOCKET_URL` | 安装包构建必填；公开可分享 | Socket.IO 站点根地址，不含 `/meeting`；通常与 API 相同 |

分发安装包前必须替换示例的 localhost 地址为实际 HTTPS 服务。环境文件不提交 Git；也可使用同名进程环境变量覆盖。数据库、JWT、七牛等密钥只保留在服务端。

桌面生产页面使用本地源：Windows 为 `http://tauri.localhost`，macOS 为 `tauri://localhost`，不能依赖网页 Nginx 的同源代理。服务端须允许该源的 CORS 请求，并提供 `/meeting` WebSocket；当前后端已有跨源配置。Tauri 权限仅对内嵌主窗口开放，不授予远程网页原生权限。

## 开发与打包

```powershell
pnpm desktop:check
pnpm desktop:dev
pnpm desktop:build
```

开发模式固定使用 1420 端口（占用时报错，避免原生窗口打开错误页面），可不设置服务地址，使用现有 localhost:3000 代理。网页仍使用原来的 `pnpm client`。

安装包位于 `client-vue/src-tauri/target/`：

- Windows：`release/bundle/nsis/*.exe`。
- macOS 本机：`release/bundle/dmg/*.dmg` 和 `release/bundle/macos/NearLink.app`。
- CI 指定 Mac 架构时：`<target>/release/bundle/dmg/*.dmg`。

Windows 当前未签名，macOS 为临时签名；尚未配置应用内自动更新。

GitHub Actions 的 **Desktop Build** 工作流在桌面功能分支推送和 PR 中检查编译与打包。分支构建默认连接现有站点 `https://www.sycsq.top`，可通过仓库变量 `DESKTOP_SERVER_URL` 覆盖；手动运行时填写的地址优先级最高。分支或手动构建成功后，从 `NearLink-windows-x64`、`NearLink-macos-arm64` 或 `NearLink-macos-x64` artifact 下载安装包。普通分支构建只上传 artifact；版本标签通过 **Desktop Release** 发布安装包，均不触发网页部署。发布方式见 [桌面版本发布](DESKTOP_RELEASE.md)。

## 验证与验收

```powershell
pnpm --filter client-vue test
pnpm --filter client-vue typecheck
pnpm --filter client-vue desktop:web:build
pnpm --filter client-vue exec playwright test --config playwright.desktop.config.ts
cargo check --manifest-path client-vue/src-tauri/Cargo.toml
pnpm desktop:build
pnpm --filter client-vue exec playwright test --config playwright.native.config.ts
```

Chrome 测试验证桌面前端产物的 hash 路由、刷新、服务地址、CSP 及页面。Windows CI 先生成正式安装包，再构建启用本地调试端口的 Release 测试程序，验证 WebView2 登录页、刷新、原生通知权限 IPC、媒体 API 可用性和重复启动的单实例行为，截图随 `Windows-validation` artifact 保存。测试配置由工作流临时生成，保留正式窗口配置，仅追加调试参数和独立数据目录；不进入已生成的安装包。WebView2 150+ 会忽略管理员进程的调试环境变量，因此通过窗口 `additionalBrowserArgs` 配置传入，参见 [上游说明](https://github.com/tauri-apps/wry/issues/1782) 与 [Playwright WebView2 文档](https://playwright.dev/docs/webview2)。本地运行原生测试前也需按工作流的 `Build native test binary` 步骤构建测试程序。安装后仍需检查：

1. 启动、重复启动、缩放、最大化、关闭到托盘、恢复、退出后重新进入。
2. 登录后私聊/群聊收发、断网重连、切换账号，确认通知设置按账号恢复。
3. 后台收到私信、群消息、来电；关闭通知或预览后符合设置；回到会话清除未读。
4. 允许/拒绝摄像头与麦克风，接听/挂断，选择/取消屏幕共享，结束后设备轨道停止。
5. 通话期间关闭到托盘仍能继续；退出应用后摄像头、麦克风及共享释放。
6. 头像选择、裁剪、取消、20 MB 限制；录制另存为、取消、覆盖和写入失败重试。

## 验证范围

单元测试和类型检查验证前端逻辑；Windows CI 验证 WebView2，macOS CI 验证两种架构的编译与打包。系统通知、双人通话、摄像头/麦克风授权、屏幕共享以及安装后的系统行为仍须分别在目标设备人工验收。
