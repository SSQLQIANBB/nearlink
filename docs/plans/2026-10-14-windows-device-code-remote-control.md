# Windows 被控与设备码远控实施记录

## 目标与顺序

整个功能按以下五步跟踪；“步骤”表示交付阶段，不代表五次修改或五次对话。只有该阶段的验收项全部通过才标为完成。

| 步骤 | 交付内容 | 当前状态 | 完成标准 |
| --- | --- | --- | --- |
| 1 | Windows 原生采屏、输入、坐标与停止释放基础 | 基础实现及两项本机实测完成 | 真实像素、中文输入、按键释放、资源回收通过；锁屏、旋转等产品场景在第 5 步统一验收 |
| 2 | Windows 编码、媒体传输、授权接入与引擎打包 | 进行中：真实回环画面与主动停止已通过；原生产品接入／打包未完成 | 真实画面编解码、认证 IPC、原生确认后传输、停止退出、固定依赖打包通过 |
| 3 | 设备代码与临时密码服务端闭环 | 下一步，未开始 | 代码唯一、密码到期／刷新／限流、请求身份绑定、本机确认、拒绝／取消通过 |
| 4 | 桌面工作台与旧预授权功能迁移删除 | 未开始；四个图标已齐 | 两个入口、右侧工作台、分享／连接交互接入真实服务，清理已被替代的旧入口及专用逻辑 |
| 5 | 完整验收及内测交付 | 未开始 | 双端控制、仅观看隔离、断网释放、30 分钟稳定性、安装包验证；跨电脑项需第二台电脑 |

先补齐 Windows 被控能力及实机验收，再实现：开启本机协助 → 展示设备代码和临时密码 → 用户自行分享 → 对方输入 → 服务端校验 → 本机确认 → 画面与键鼠控制 → 任一方结束。

当前只有一台 Windows 电脑。单机原生测试不等于跨电脑、跨网络或安装包验收。账号使用范围不作区分；`engineReady` 仍由实际引擎探测结果决定。

### 每一步的 macOS 兼容要求

用户要求每一步同时保持 macOS 兼容，以下要求纳入原五步，不新增阶段：

| 步骤 | macOS 必须保留或验证的内容 |
| --- | --- |
| 1 | 保留 Quartz 逻辑坐标、原有采屏与辅助功能权限检查、输入注入和松键路径；不能将 Windows 物理像素逻辑直接套用到 Retina |
| 2 | 保留 Swift 采屏、VideoToolbox 编码、认证 IPC、媒体租约、SIGTERM 清理和 macOS 固定引擎包；共用协议改动覆盖双方回归 |
| 3 | 设备码和临时密码采用统一服务端协议，分别绑定真实设备身份与平台能力；校验成功不能绕过任一平台的本机确认 |
| 4 | 同一桌面工作台适配 Windows/macOS；复制、显示隐藏、刷新、原生确认和结束行为分别验证，旧流程在两端替换完成后清理 |
| 5 | Windows 与 macOS 均需真实采屏、键鼠、权限拒绝、断线释放和安装包验收；macOS ARM64/Intel 的构建与支持范围分别记录，不能由 Windows 测试代替 |

当前无 Mac 实机，本轮只能执行共用协议及 macOS 分支的自动化回归，不标记 macOS 实机验收完成。

## 本批已实现的原生基础

- Windows 输入执行器使用 SendInput，沿用既有签名会话、输入票据、期限检查与按键释放链路；支持物理扫描码、鼠标、滚轮和 UTF-16 文本。发送失败不得返回成功 ACK。
- 单独记录本执行器实际注入的按键、鼠标和待释放 Unicode 单元；释放仅针对本执行器持有的输入，不合成本地用户的 key-up。
- 输入前检查交互桌面、显示布局和票据期限；锁屏／UAC 安全桌面不作为可操作桌面。
- 从 Windows 显示设置读取物理屏幕尺寸与旋转；增加 QPC 单调时钟读取。
- 增加主屏 BGRA 采集基础，通过 GDI 读取真实画面；采集线程临时使用物理像素 DPI 上下文，退出后恢复。资源由 RAII 释放，采集前后检查桌面和布局。
- 新增手动选择运行的本机测试：真实采屏及 GDI 资源释放；临时原生窗口接收中文／表情、物理按键与强制松键。

这些基础仍不构成可连接的 Windows 被控产品。采屏源尚未接入编码、媒体传输与签名引擎包，产品 Windows 发布入口继续关闭。

## 已取得的证据

- 本机真实主屏采集：2560×1600 BGRA，连续创建／采集／销毁 10 次；非空像素及长度检查通过，GDI 资源数恢复到初始值。不保存屏幕图像。
- 本机真实输入：临时原生 EDIT 窗口准确收到 `NearLink中文👋`；End 按下／松开通过，强制释放后 ShiftLeft 系统按键状态回到松开，执行器不再持有按键。测试前检查前台窗口及本地修饰键状态。
- 最终原生回归：129 项通过、0 失败、3 项环境测试默认忽略。其中本机采屏和本机输入两项已单独显式执行通过；另一项为 macOS 引擎资源测试，本机未执行。
- `git diff --check` 通过。没有进行前端 UI 验收、Windows 媒体传输或安装包验收，没有升级版本、提交或发布。

执行命令（需要 MSVC Developer PowerShell 环境）：

```powershell
cargo test --manifest-path client-vue/src-tauri/Cargo.toml --bin nearlink-desktop remote_control
cargo test --manifest-path client-vue/src-tauri/Cargo.toml --bin nearlink-desktop remote_control::windows_capture::tests::live_capture_and_release -- --ignored --nocapture --test-threads=1
cargo test --manifest-path client-vue/src-tauri/Cargo.toml --bin nearlink-desktop remote_control::input::windows::tests::live_unicode_key_and_release -- --ignored --nocapture --test-threads=1
```

## 仍待完成

1. Windows 编码与媒体引擎：本机已安装隔离的 GStreamer 1.28.7 开发环境，DLL 加载、管道等待与单调时钟已适配，真实采屏编码解码探针通过；仍需将 Windows 屏幕源接入既有签名授权和认证 IPC 产品流程。
2. 发布打包：现有引擎清单只接受 macOS ARM64，需增加真实 Windows 二进制、依赖闭包、哈希核验及构建验证；不能只扩大允许的 target 字符串。
3. 产品连接：移除前后端本机上线流程中的 macOS 写死值，接入实际原生能力；补齐 Windows 原生确认、停止、权限丢失及进程退出验收。
4. 实机验收：本机输入执行、画面编码／解码、授权拒绝、仅观看隔离、双端停止、断网释放、30 分钟连续连接、缩放和旋转。跨电脑验收需另一台电脑。
5. 设备代码与临时密码：服务端分配唯一代码；密码仅以适当验证材料保存，支持到期、刷新与错误尝试限流；成功验证绑定当前请求账号、被控设备、连接代次及本次请求，不自动生成永久协助许可。
6. UI：桌面头像下方并排入口、右侧远控工作台、设备码／密码复制及显示隐藏、密码刷新、输入目标代码和密码、请求取消及原生确认结果。
7. 迁移清理：新流程替代后删除联系人预授权配置及仅供旧流程使用的代码／测试。设备身份、原生确认、会话租约、输入保护和停止释放继续复用；旧授权数据另做显式迁移，不能直接删表。

## 第二步续行（2026-10-14）

- 已核对四个新增图标类，尚未制作工作台 UI。
- 现有引擎加入 Windows QPC 对应时钟、继承管道就绪检测、带截止时间的非阻塞写入，以及明确的 SDK DLL／typelib 路径；没有修改现有认证、租约或发布门禁。
- Windows SDK 1.28.7 已安装在 `%LOCALAPPDATA%/NearLink/remote-engine-dev` 独立 venv，自有产品依赖与第三方锁文件未变。运行时尚未打进产品安装包。
- 前端、Rust 和 Python 布局合同新增 `windows-desktop-physical`，保留 macOS 原有坐标类型。
- `remote-control-windows-media-probe.py`：真实主屏 → D3D11 采屏 → Media Foundation H.264 → OpenH264 解码，取得 30 帧 1280×720 BGRA；检查非黑画面、时间戳递增和管线回到 NULL，未联网、未保存画面。两次成功运行首帧约 1582ms、3155ms。其间另一次进程退出码为 `0xC0000005`，未获得原因；不能据成功重跑认定稳定性通过。
- `remote-control-windows-engine-check.py`：真实继承管道及 HMAC 握手、停止、子进程退出通过；未发 offer／租约，也未启动采屏。Windows venv 的 Python 启动器与工作进程 PID 不同，此探针只验证认证 IPC；产品原生启动器的 PID、子进程树监督仍需补齐，不能放宽现有产品 PID 校验。
- Python 远控测试 44 项通过；前端坐标合同 11 项通过。新增 Rust 布局测试未完成执行：首次链接报 LNK1102 内存不足，`-j 1` 重试仍报内存分配失败；没有将历史原生测试结果当成本轮结果。

当前仍处于第 2 步，下一项为将 Windows 屏幕源接入受授权的产品媒体链路，完成固定引擎包及原生进程监督，随后进入第 3 步。当前机器内存紧张，恢复资源后需补跑 Rust 检查；跨电脑验收仍需第二台电脑。

可复现开发环境与探针命令：

```powershell
$runtimePath = Join-Path $env:LOCALAPPDATA 'NearLink/remote-engine-dev'
python -m venv $runtimePath
& "$runtimePath/Scripts/python.exe" -m pip install --only-binary=:all: gstreamer-python==1.28.7 gstreamer-plugins==1.28.7 gstreamer-plugins-libs==1.28.7 gstreamer-libs==1.28.7 gstreamer-ext-runtime==1.28.7
& "$runtimePath/Scripts/python.exe" scripts/remote-control-windows-media-probe.py
& "$runtimePath/Scripts/python.exe" scripts/remote-control-windows-engine-check.py
```

采屏组件的主屏参数依据 [GStreamer d3d11screencapturesrc](https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html)。本机编解码探针不是端到端连接验收。

## 第二步：Windows 进程树监督补齐（2026-10-14）

- 新增 `windows_process.rs`，以 `CREATE_SUSPENDED` 创建引擎，配置不继承的 `KILL_ON_JOB_CLOSE` Job 并完成归属后才恢复主线程。启动器尚未运行即可纳入监督，避免其后代抢先脱离进程树管理；归属失败直接终止启动，不继续发送认证引导。
- `host_process.rs` 复用现有 `ReapedChild` 生命周期。主动超时终止、正常引擎退出后的后代清理和析构均作用于 Job；应用进程退出时由 Windows 关闭 Job 句柄。未放宽 PID、认证、媒体租约或平台发布条件。
- 两项本机测试通过：启动真实隐藏 PowerShell 父子进程，分别主动终止 Job、关闭 Job 句柄，并等待两级进程句柄确认退出。测试不采屏、不操作键鼠。应用崩溃路径目前依据 Job 句柄语义，尚未单独进行产品崩溃注入测试。
- 共享 Cargo 缓存正在被其他构建占用，使用 `%LOCALAPPDATA%/NearLink/job-supervision-check` 独立小工程与本地相同版本依赖，直接引用仓库 `windows_process.rs`、编译当前 `ReapedChild` 源码片段。该检查不等于完整 Tauri 应用编译通过。
- 本轮 Python 远控回归 44 项通过；本轮修改文件 `git diff --check` 通过。全仓检查发现用户新增字体演示 HTML 中已有行尾空白，未修改供应商资源。
- **当前仍为第 2 步**。下一项仍是 Windows 屏幕源接入授权媒体链路及固定引擎包；尚未取得产品端到端画面、键鼠与异常断线释放证据。第 3～5 步保持原计划，没有新增阶段。

## 第二步：Windows 屏幕源接入与跨平台协议回归

- 新增 `scripts/remote-control-windows-screen-source.py`：D3D11 主屏采集 → 显式保持比例／补黑边 → Media Foundation H.264 → 既有二进制帧管道。输出物理像素布局、独立采集／编码进度，检查当前交互桌面和布局变化；父管道关闭、心跳超时及输出阻塞时停止。采屏源不联网、不保存画面、不注入输入。
- 与原 Swift 源保持同一帧／诊断合同。真实 Windows 主屏 2560×1600 映射至 1280×720，内容矩形为 `(64, 0, 1152, 720)`。独立运行得到 229 帧 H.264，父管道关闭后管线回到 NULL、进程退出。
- 共用引擎已接收 Windows 布局与连续转发进度。最终真实回环主动停止探针通过：DTLS 证书核对、双数据通道、授权前 0 帧、授权后浏览器呈现 10 帧；主动结束后采屏源退出、管线回到 NULL、画面帧数稳定。该开发探针不执行 OS 输入，不替代服务端签名租约、本机原生确认和键鼠的产品端到端验收。
- 实测 Windows SPS 为 `42401f`，为 Windows 本地 RTP caps 补充该值。依据 [RFC 6184 Table 5](https://www.rfc-editor.org/rfc/rfc6184.html)，它与既有 `42e01f`、`42c01f` 同属 constrained baseline；不改写 SPS，macOS 保持原列表。补边使用 I420 后转 NV12，避免 videobox 不支持 NV12 的协商错误。
- 基础 GStreamer 加载与 WebRTC 依赖加载分开，Windows 采屏源只加载实际需要的采集／编码插件；原引擎仍加载既有网络插件。Windows 停止通过父管道 EOF 触发源清理，原 macOS SIGTERM 路径保留。
- 实测 MF 编码首帧 PTS 为 `3600000` 秒（1000 小时），导致另一条管线的 appsrc 一直等待未来时间，浏览器无视频接收统计。Windows 源出口改为减去首帧 PTS，保持实际帧间隔；QPC 活动时间戳及 macOS Swift 码流时间戳不变。修改后浏览器真实呈现通过。
- 回环探针增加显式浏览器 channel、Windows QPC、租约续期、分阶段进度和不含画面／地址的接收统计。对无响应浏览器调用和退出补充截止时间；未扩大产品租约上限或修改发布门禁。
- 本轮 Python 回归 49 项通过，包含 macOS 原 caps 与停止信号不变、Windows 布局、父管道关闭、非法消息和心跳超时。认证启动／停止探针再次通过，未采屏。中间实测出现可用物理内存约 280～375MB、初始化超时和浏览器调用无响应，已清理对应测试进程；这些现象没有被当成画面问题的根因，画面问题以 PTS 证据定位。
- 当前仍在第 2 步。接下来完成异常停止验收、固定 Windows 引擎包和原生产品接入。macOS 实机回归、跨电脑控制和安装包验收仍未完成。
- 主动结束通过后的异常路径批测：`lease` 在 Windows 源初始化阶段超时（没有布局和采集进度），未进入租约到期验收；批测立即停止，`eof`、`heartbeat` 尚未执行。主动结束的单次通过不能作为启动稳定性或四种停止模式全部通过的证据。

复现回环开发探针（不开放产品入口、不访问外部 ICE 服务器）：

```powershell
$env:REMOTE_CONTROL_PROBE_PYTHON = Join-Path $env:LOCALAPPDATA 'NearLink/remote-engine-dev/Scripts/python.exe'
$env:REMOTE_CONTROL_PROBE_BROWSER_CHANNEL = 'msedge'
node scripts/remote-control-host-engine-probe.mjs --stop-mode=stop
# 后续分别执行 --stop-mode=lease / eof / heartbeat
```

## 第二步：异常停止与 Windows 固定候选包

- 续测开发环境的三条异常停止路径通过：租约到期 `MEDIA_LEASE_EXPIRED`（224 帧）、父管道关闭 `SUPERVISOR_EOF`（11 帧）、心跳超时 `SUPERVISOR_TIMEOUT`（54 帧）。均验证授权前 0 帧、授权后真实呈现、采屏退出及停止后帧数稳定。结合此前主动停止，四种模式均取得单次实测通过；这不覆盖重复启动稳定性。
- 新增 Windows x64 候选包构建器与嵌入 CPython 的原生启动器。引擎和采屏源使用固定入口、不接受解释器参数，不依赖虚拟环境启动器；认证握手 PID 与原生子进程 PID 一致。Windows 系统目录通过系统 API 取得，避免清空环境后 Winsock 无法初始化。
- 包含固定 SDK 1.28.7、Python 3.13.0、显式插件及 typelib；审计 AMD64 PE、导入依赖和转发导出，补入固定 SDK 中的传递 DLL，拒绝不同内容的同名 DLL。生成逐文件 SHA-256 清单与构建证据。此清单尚未接入 Windows 原生信任校验，不等于发布可用。
- 最终本机候选目录 `%LOCALAPPDATA%/NearLink/engine-candidate-20261014-b`：856 个清单文件、180692652 字节、202 个原生文件。全部文件大小／哈希复核通过；带空格目录迁移、外部 PYTHONHOME/PYTHONPATH 和同名模块干扰下认证启动／停止通过；额外启动参数被拒绝。早期 `-a` 目录为已修改的诊断样本，不能使用其清单验收。
- 固定候选包真实回环主动停止通过：授权前 0 帧、授权后浏览器呈现 10 帧、真实 DTLS 和双通道校验、采屏源退出码 0、停止后帧数稳定。该探针只验证输入消息转发，不执行 OS 键鼠输入，也不替代服务端签名租约和原生确认。异常停止三项本轮运行的是开发环境引擎，尚未在固定候选包重复。
- Python 回归 53 项通过，新增依赖闭包、未固定依赖拒绝、重复 DLL 冲突和架构校验测试。共享引擎的新增 typelib 路径仅进入 Windows 分支；macOS 加载、Swift 源和打包器保持原路径，但无 Mac 实机验证。
- 当前仍为第 2/5 步：下一项为 Windows 原生包信任校验与产品确认／停止接入，再推进第 3 步设备代码和临时密码、第 4 步工作台和旧流程清理、第 5 步双平台验收。产品 Windows 远控门禁继续关闭，跨电脑、macOS、安装包及长时间运行尚未验收。

固定候选包复现（先使用 MSVC 开发环境和固定 SDK Python 构建至新目录）：

```powershell
& "$env:LOCALAPPDATA/NearLink/remote-engine-dev/Scripts/python.exe" scripts/package-remote-control-engine-windows.py --output "$env:LOCALAPPDATA/NearLink/engine-candidate-new"
& "$env:LOCALAPPDATA/NearLink/remote-engine-dev/Scripts/python.exe" scripts/remote-control-windows-engine-check.py --bundle-engine "$env:LOCALAPPDATA/NearLink/engine-candidate-new/bin/remote-control-engine.exe"
$env:REMOTE_CONTROL_PROBE_ENGINE = "$env:LOCALAPPDATA/NearLink/engine-candidate-new/bin/remote-control-engine.exe"
# 同时设置上文的 REMOTE_CONTROL_PROBE_PYTHON 和浏览器 channel，再执行回环探针。
node scripts/remote-control-host-engine-probe.mjs --stop-mode=stop
```

## 开发顺序调整：先完成功能，再统一验收

按用户最新要求，后续开发不逐步运行 test、lint、typecheck、build 或实机验收；功能整体完成后集中进行。运行时设备身份、临时密码、本机确认、签名租约与停止释放机制继续保留。

- 第 2 步剩余 Windows 原生包信任校验／产品接入仍待开发；不因暂缓测试而放开未接入的产品门禁。
- 第 3 步已编写：当前在线协助连接分配九位代码、十位临时密码、15 分钟有效期、刷新、账号和设备码尝试限流、断线失效。服务端仅保留进程密钥 HMAC，明文只在签发响应中返回；重启不恢复在线密码。与当前单进程 authority 保持一致，设备代码在重新开启协助时重新分配。
- 密码通过后生成仅绑定本次 requestId、主控账号／登录会话／连接、被控设备／连接及请求范围的内存 admission；复用现有 Redis 会话、SQL 历史、原生确认和媒体授权。历史 grantId 字段在 device-code 会话中保存本次 admission UUID，不创建 AssistanceGrant 或永久联系人许可。历史记录不用于恢复授权。刷新使尚未确认的旧请求失效，已确认会话继续至结束。
- 第 4 步已编写工作台与入口：桌面头像区“个人中心／远程控制”并排，右侧显示本机协助、设备码、临时密码、复制／显隐／刷新、连接表单、仅观看／控制、取消／结束；独立远控路由复用同一组件。使用已提供的四个图标。设备登记与 macOS 权限入口保留，旧联系人预授权设置从页面卸下；旧后端接口与未引用组件尚待后续清理。
- 主控适配器在密码验证后的响应中取得真实目标 ID，后续连接仍核对该 ID；密码不进入 Pinia、localStorage 或会话历史。被控平台改为读取原生能力，协议接受 Windows/macOS，发布门禁未扩大。
- 设备码签名确认请求新增 requireLocalConfirmation；原生端忽略旧的自动批准记录，不保存本次“记住”选择，macOS 对应确认框隐藏记住选项。旧签名请求缺省值保持原行为，需随新客户端一起部署新服务端。
- 本轮以上变更均为**已编码、未校验**，未运行测试／构建／实机验收。下一步继续第 2 步产品原生接入和第 4 步遗留流程清理，完成后进入第 5 步集中验证，不增加新的阶段。

## 开发收尾（按要求暂不执行校验）

本节为当前状态；前面的逐轮记录是历史进度。五步中的第 1～4 步已完成代码接入，第 5 步集中验收尚未执行，不能据此标记产品验收通过。

1. **系统基础能力：已编码。** Windows 主屏采集、物理坐标及 SendInput；macOS 沿用 ScreenCaptureKit／原生输入和 TCC 权限流程。
2. **引擎与产品接入：已编码。** Windows x64 固定资源包进入 build.rs 和生产启动工厂；逐文件哈希与编译期清单匹配，拒绝 reparse point／硬链接／额外资源，运行期间持有禁止写入和删除共享的资源句柄。进程树继续由 Job 监督。原生上线证据携带实际 OS，服务端核对其与连接平台一致。macOS 原有 ARM64 引擎构建和资源校验分支保留。
3. **设备码认证：已编码。** 设备码和临时密码是唯一新请求入口；一次性 admission 与账号、连接、请求和范围绑定，不写永久许可。ICE 接口改为复用共享会话授权实例，避免临时授权在媒体配置阶段被旧实例拒绝。未确认的 admission 45 秒过期，确认后的授权不超过会话硬期限。
4. **工作台与迁移：已编码。** 桌面并排入口、右侧工作台、复制／显隐／刷新、连接／取消／结束及 macOS 权限设置。删除旧 RemoteHostSettings 与其专用测试，删除联系人设备发现、预授权创建／列表接口及前端调用。历史表、旧会话授权检查和旧许可撤销接口保留，避免破坏历史审计和在途会话，不再允许借旧许可创建新会话。
5. **集中验收：按用户要求未执行。** 本轮没有运行测试、lint、typecheck、build、打包、实机或浏览器验收。已更新受协议和入口移除影响的相关用例，并补充设备码限流／失效用例，均未运行。Windows 和 macOS 的编译、权限、实际传输、停止释放、跨电脑、稳定性及安装包检查留待统一验证。

### 交付与运行前提

- 支持本轮实现的平台范围为 Windows 11 x64、原有 macOS 13+ ARM64 被控引擎。没有新增 macOS Intel 或 Windows ARM 被控引擎，也未宣称这些平台可用。
- 两端需要登录，首次使用需登记本机。服务端要求可信签名密钥、SQL／Redis 和 TURN；已移除远控账号白名单，所有已登录账号均可使用，实际连接仍检查引擎、权限和本机确认。
- 必须用最新源码重新生成引擎资源，再通过现有包装脚本选择资源；历史候选目录 `engine-candidate-20261014-b` 不包含本次全部修改。只编译普通聊天客户端、未附带引擎时，本机协助不可用是预期行为。
- 后续 Windows 构建命令（本轮未执行）：先在 MSVC 开发环境以固定 SDK Python 运行 `scripts/package-remote-control-engine-windows.py --output <新的绝对目录>`，再运行 `node scripts/remote-control-desktop-build.mjs --bundle <该绝对目录> -- --target x86_64-pc-windows-msvc`。macOS 使用既有 `scripts/package-remote-control-engine.py` 和同一桌面包装脚本，选择对应 ARM64 包。
- 新客户端与新服务端需一起部署：旧客户端的 targetDeviceId 请求格式已不再接受；每次本机确认由签名字段约束，旧版原生端不能接收新的确认请求。未创建 Git 提交、标签、安装包或发布；版本升级应随该批正式提交执行。

### 图标状态

可复用已有电脑、锁、提示、警告、关闭图标。用户已补齐并在当前字体包核对：`icon-copy1`（复制）、`icon-show_password`（显示密码）、`icon-hide_password`（隐藏密码）、`icon-refresh`（刷新密码）。保留下载字体包完整，不把业务样式写入字体包。分享采用“一键复制连接信息”，无需单独引入分享图标；二维码不在本期范围。
