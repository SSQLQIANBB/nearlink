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
- 桌面通话中的屏幕共享通过 XCap 原生采集接入 WebRTC；macOS 仍需要系统屏幕录制授权，窗口枚举、采集、边框位置及 Retina/多显示器行为须在真实设备验收。

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

桌面生产页面使用本地源：Windows 为 `http://tauri.localhost`，macOS 为 `tauri://localhost`，不能依赖网页 Nginx 的同源代理。服务端须允许该源的 CORS 请求，并提供 `/meeting` WebSocket；当前后端已有跨源配置。Tauri 权限按内嵌窗口分别授予，预览和通话窗口没有远控权限，不授予远程网页原生权限。

## 独立窗口

仅 Tauri 桌面客户端将图片预览、私聊/群组音视频通话和屏幕共享放入独立原生窗口；网页保持原来的预览弹层及通话页面。图片窗口可与通话窗口同时存在，每次只保留一个媒体会话。

- 主窗口继续管理登录、消息和唯一的 Socket 连接，通过 Tauri IPC 转发媒体信令；通话窗口持有媒体轨道及 WebRTC 连接，令牌刷新统一交给主窗口。
- 最小化通话窗口继续通话；关闭通话窗口会挂断并释放媒体。主窗口关闭仍隐藏到托盘，整个应用退出才全部结束。
- 屏幕共享使用桌面/应用窗口缩略图选择面板，支持按应用筛选和刷新列表。确认“开始共享”后隐藏通话窗口，显示可拖动的置顶控制条及绿色共享区域边框；控制条仅显示共享状态、时长及结束共享按钮。应用窗口关闭或最小化会结束采集。
- 选择面板仅提供已接通的画面共享能力，不提供白板、文档共享或系统声音共享。群组共享继续使用原有麦克风流程。清晰度优先输出最长宽度 1600，目标 10 fps；流畅度优先最长宽度 1280，目标 20 fps，实际帧率受系统采集和编码耗时影响。
- 原生采集通过二进制 IPC 返回 JPEG 帧，前端转换为 canvas 视频轨道，复用现有 WebRTC；采集节奏由原生端控制，并显式提交 canvas 帧，避免隐藏 WebView 的 JavaScript 定时器降频。停止、取消、过期帧和窗口销毁都按会话 token 清理；边框不拦截鼠标操作。
- 退出登录、断开信令或刷新主窗口会关闭媒体窗口；刷新通话窗口会结束旧会话，需要从主窗口重新发起。
- `tests/desktop/auxiliary.spec.ts` 使用模拟原生 IPC 验证图片操作、语音关窗释放、共享源选择/取消/停止和控制条操作；`desktopScreenShare.test.ts` 验证采集生命周期。Rust 的 `screen_share::tests` 包含需显式运行的真实桌面/窗口采集测试，图像只在内存中处理。这些检查不替代真实操作系统窗口和双端媒体验收。

## 开发与打包

```powershell
pnpm desktop:check
pnpm desktop:dev
pnpm desktop:build
```

开发模式固定使用 1420 端口（占用时报错，避免原生窗口打开错误页面），可不设置服务地址，使用现有 localhost:3000 代理。网页仍使用原来的 `pnpm client`。

### 远控引擎启动入口

进入远控页面后自动初始化或复用本机身份、上线并生成设备代码及临时密码，无需手动登记。本机确认仍在对方发起连接后进行。

本地后端 `.env.local` 为 `NODE_ENV=development` 且尚无签名配置时，开发启动会生成 Ed25519 签名配置并保存到该被忽略的文件；只有对应公钥编入桌面 debug 程序。已有完整配置会复用，不会覆盖。首次生成后需重启后端，不能仅刷新页面。生产构建不加载开发公钥。

`npm run desktop:dev`（或 `pnpm desktop:dev`）自动准备对应平台的远控引擎，再启动桌面程序。根目录与 `client-vue` 目录均可执行。已运行的原生程序不会通过前端热更新获得引擎，请先退出旧客户端再启动。

自动流程会加载 Windows MSVC x64 开发环境、创建或复用隔离 Python 环境、安装固定 GStreamer 1.28.7 wheels，并按源码摘要缓存引擎到已忽略的 `dist/remote-control-dev`。Windows 优先复用 `%LOCALAPPDATA%/NearLink/remote-engine-dev` 中已有 SDK。首次准备需要网络和构建时间，失败时直接停止并输出原因，不会退回无引擎模式。

开发机器需有 Windows x64 CPython 3.13、Visual Studio 桌面 C++ 工作负载及 Windows SDK；macOS Apple 芯片需 CPython 3.13.2 framework 版本与 Xcode Command Line Tools。这些是开发依赖，最终用户不需要单独安装远控插件。Intel Mac 的本机被控引擎尚不支持，可用 `npm run desktop:dev:chat` 开发普通聊天功能。

`desktop:dev:chat` 和普通 `desktop:build` 不自动选择引擎。分发远控安装包仍须显式选择已经验收的资源，不会使用开发缓存自动发布。

如果需要使用手动生成的指定引擎目录，从仓库根目录执行：

```powershell
pnpm desktop:remote:dev --bundle "D:/absolute/path/to/engine-bundle"
# 分发构建使用同一资源选择流程
pnpm desktop:remote:build --bundle "D:/absolute/path/to/engine-bundle"
```

macOS 使用相同命令，将路径换成对应 Apple 芯片引擎目录。包装入口同时设置编译期清单和 Tauri 资源映射，Windows 直接通过 Node 启动 Tauri CLI，避免直接 spawn `.cmd` 的兼容问题。资源检查、引擎握手和系统权限仍需通过，选择引擎不等于已开放或验收通过。

页面提供“刷新可用状态”更新权限和服务端状态；引擎探测结果在当前进程内缓存，修复资源或启动失败后必须重启桌面程序。

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
5. 通话期间主窗口关闭到托盘仍能继续；独立窗口支持拖动、最小化、最大化，关闭后摄像头、麦克风及共享释放；退出应用后所有窗口与媒体结束。
6. 头像选择、裁剪、取消、20 MB 限制；录制另存为、取消、覆盖和写入失败重试。

## 验证范围

单元测试和类型检查验证前端逻辑；Windows CI 验证 WebView2，macOS CI 验证两种架构的编译与打包。系统通知、双人通话、摄像头/麦克风授权、屏幕共享以及安装后的系统行为仍须分别在目标设备人工验收。
