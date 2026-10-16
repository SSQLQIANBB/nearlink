# 桌面版本发布

开发分支为 `feature/desktop-tauri`。桌面端使用独立的 `desktop-v` 标签前缀，避免与网页版本混淆。下载地址：<https://github.com/SSQLQIANBB/nearlink/releases>。

Windows x64 / Apple 芯片 macOS 的 `pnpm desktop:build` 会自动准备固定版本 SDK、从源码制作引擎，并将完整引擎资源及清单嵌入安装包；制作失败即停止打包。也可用 `pnpm desktop:remote:build --bundle <绝对路径> -- <Tauri 参数>` 选择已有资源。构建机需要 Windows CPython 3.13 与 MSVC，或 macOS CPython 3.13.2 与 Xcode Command Line Tools；可用 `TODE_ENGINE_BUILD_PYTHON` 指定构建解释器。终端用户无需安装 Python/GStreamer，也无需为缺少引擎修改服务器配置。`desktop:build:chat` 仅用于聊天功能验证，不能作为远控版本发布。当前发布流水线尚未准备全平台引擎和实机验收记录，因此不能发布宣称支持远控的安装包。

## 统一产品版本与提交规则

当前源码产品版本为 `0.8.0-alpha.4`，处于内测阶段。根目录 `package.json` 的 `version` 是唯一维护入口，前端、后端、Tauri、Rust 包及 `Cargo.lock` 中的自有包版本保持一致。第三方依赖版本不加内测标识。界面、桌面窗口、托盘和 Release 说明显示“内测版”及完整版本；应用名为 `NearLink`，仓库名为 `nearlink`；应用标识继续使用 `top.sycsq.todesk`，以沿用现有应用数据标识。新安装包与 macOS 应用名使用 `NearLink`，旧版安装路径和系统权限的迁移仍需实机验证。域名、服务器部署目录、容器与数据库名称、协议和存储键保持不变。

| 变更 | 版本操作示例 |
| --- | --- |
| 新增较大功能、重要协议或架构升级 | `0.2.0-alpha.1` → `0.3.0-alpha.1`，次版本递增，修订版本和 alpha 序号重置 |
| 同一功能阶段的小功能、优化、尚未发布的修复 | `0.2.0-alpha.1` → `0.2.0-alpha.2` |
| 对已经分发的版本单独发布兼容性缺陷或安全修复 | `0.2.0-alpha.2` → `0.2.1-alpha.1` |
| 仅文档、测试整理且不产生新的分发包 | 可保留版本；不能复用已有标签覆盖安装包 |

大改动应在对应批次的中文提交中同时升级版本，不能到发布时才补版本。`0.x` 内测阶段的重要不兼容变更也递增次版本，并记录兼容性影响；未来结束内测或升主版本需另行明确，当前脚本拒绝不含 `-alpha.N` 的正式版本。

```sh
# 一次同步所有版本来源，并自动递增 macOS 数字构建号
pnpm version:set 0.3.0-alpha.1

# 保留当前版本与构建号，只修复来源不一致
pnpm version:sync

# 只读校验；本地构建、测试及 CI 也会执行
pnpm version:check
pnpm test:release
```

版本维护命令不创建提交或标签、不安装应用。重复设置同一版本不会增加构建号；拒绝版本回退。`version:check` 能检查来源是否一致，变更是否属于“大功能”仍由提交者与评审者判断。`pnpm-lock.yaml` 不记录工作区自身版本，本次版本升级无需改写依赖锁定结果。

## 系统版本字段

产品版本与安装包文件名保留 `0.8.0-alpha.4`。macOS 的 `CFBundleShortVersionString` 要求三个数字段，`Info.plist` 因而显式写入 `0.8.0`；`CFBundleVersion` 使用根 `package.json` 中独立递增的 `desktopBuildNumber`（本版为 `31`），通过 `bundle.macOS.bundleVersion` 写入。完整内测版本仍在界面和 `CFBundleGetInfoString` 中展示。两项数字字段遵循 [Apple 短版本要求](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)和 [Apple 构建号要求](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)。

Windows 使用当前 Tauri 2.11.5 的 NSIS 默认流程：数字资源版本为 `0.8.0.0`，显示版本和安装包名保留 `0.8.0-alpha.4`；安装升级比较完整语义版本，因此 alpha 序号仍能区分升级。无需把预发布后缀塞入数字字段，也不改造默认安装模板。依据：[Tauri NSIS 数字版本转换](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.5/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs)、[默认安装模板与版本比较](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.5/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)。若以后切换 MSI，需要另行核对 MSI 版本限制。

## 一次发布的操作

1. 在该批功能提交前运行 `pnpm version:set <新的内测版本>`，并一起提交同步后的文件。首次统一版本为 `0.2.0-beta.1`（历史版本）。
2. 运行 `pnpm version:check`、`pnpm test:release`、相关功能测试和类型检查；用 `cargo check --locked --manifest-path client-vue/src-tauri/Cargo.toml` 核对 Rust 依赖。版本脚本直接同步本包的 `Cargo.lock` 条目，不会更新第三方依赖。
3. 提交并推送代码，再推送对应版本标签。以 `0.2.0-alpha.1` 为例，在仓库根目录执行：

```sh
node scripts/desktop-release.mjs desktop-v0.2.0-alpha.1
git push origin feature/desktop-tauri
git tag -a desktop-v0.2.0-alpha.1 -m "发布桌面端内测版 0.2.0-alpha.1"
git push origin desktop-v0.2.0-alpha.1
```

当前发布一律标记为 GitHub Prerelease。已发布标签不可重复使用或移动；修复后请递增版本号。标签必须指向包含 `.github/workflows/desktop-release.yml` 的提交，无需先合并 master。普通分支推送不创建 Release。工作流由 GitHub 自带的 `GITHUB_TOKEN` 发布，不需要额外的个人访问令牌。

## 自动流程

1. 校验所有自有包、Tauri、Rust 锁文件、平台版本字段与标签是否一致，不一致时在构建前失败。
2. 运行前端测试、类型检查（打包前执行）、Rust 编译并构建三个安装包。Windows 还运行现有的 WebView2 原生测试。
3. 三个平台全部成功后，检查安装包数量并生成 `SHA256SUMS.txt`。
4. 创建 Release 草稿，附加所有安装包及 SHA-256 校验文件；保持草稿，等待精确安装包的实际远控验收后再另行发布。Intel Mac 当前只构建聊天验证包，不能视为全平台远控支持。

失败的构建不会发布 Release。若上传阶段中断，可在 Actions 中重跑失败任务，流程会补齐同一个草稿的附件；已公开发布的版本不会被覆盖。

| 系统 | 下载文件 | 安装方式 |
| --- | --- | --- |
| Windows x64 | `NearLink_0.8.0-alpha.4_x64-setup.exe` | 运行安装程序 |
| Apple 芯片 Mac | `NearLink_0.8.0-alpha.4_aarch64.dmg` | 打开后拖入 Applications |
| Intel Mac | `NearLink_0.8.0-alpha.4_x64.dmg` | 打开后拖入 Applications |

文件名中的版本随配置变化。Mac 需要 macOS 12 或更新版本。

每次发布会自动在说明顶部生成 Windows、Mac（Apple 芯片）、Mac（Intel 芯片）三个中文下载入口，直接指向该版本的安装包。Mac 用户可在苹果菜单 →“关于本机”查看芯片类型。GitHub 自动附带的 `Source code (zip)` 和 `Source code (tar.gz)` 是源码，不是安装包；`SHA256SUMS.txt` 仅用于校验。

## 服务地址与签名

- 安装包默认连接 `https://www.sycsq.top`。可在仓库 Settings → Secrets and variables → Actions → Variables 中设置 `DESKTOP_SERVER_URL`，填不含 `/api` 的 HTTPS 根地址。
- 普通手动构建可通过 `server_url` 输入覆盖地址；标签发布使用仓库变量或默认地址。
- 当前 Windows 安装包未签名；Mac 使用 ad-hoc 临时签名，未经过 Apple 公证。下载后可能被系统阻止，公开分发前建议接入正式证书与公证。参见 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/)。
- GitHub Releases 提供版本列表和下载安装包；应用内检查更新、静默升级尚未实现。
- 构建成功不等于全部设备功能已验收，尤其 macOS 屏幕共享受 WKWebView 兼容性影响；人工验收清单见 [桌面端说明](WINDOWS_DESKTOP.md)。

## 验证边界

- 版本脚本与发布校验包含 10 项自动测试：来源漂移、重复同步、版本排序、数字构建号、非法版本及写入前失败保护。前端界面改动需通过类型检查及现有测试。
- 桌面 hash 路由、刷新和服务地址导航测试通过；模拟原生 CSP 的登录样式回归测试通过，Mac 原生窗口截图确认输入框、标签和图标正常。
- 既有 Mac ARM64 `.app` / `.dmg` 打包链路已验证；每次新版本仍需核对最终安装包版本、生产服务地址、签名完整性和启动结果。版本脚本测试不代替打包验收。
- Windows 和 Intel Mac 构建由 GitHub Actions 执行；真实设备音视频、通知与屏幕共享需要分别验收。

### Alpha 标识迁移

当前内测统一使用 `alpha.N`，版本校验拒绝 `beta`、`rc` 和正式版；历史标签、发布记录和第三方依赖版本不改写。本次由 `0.8.0-beta.4` 切换为 `0.8.0-alpha.4`，数字构建号从 30 增至 31。同一基础版本按 SemVer 排序时 alpha 低于 beta，数字构建号不能代替 Windows 安装器的完整版本比较；从旧 Beta 包覆盖安装的行为需实机验证，不能视为普通递增升级。后续 Alpha 迭代继续使用 `pnpm version:set`。

### 引擎补齐的交付边界

此修复改变后续安装包的构建方式，不会修改已经安装的 exe。Windows 用户需要安装新制作的含引擎版本并完全退出旧进程后重新启动。此批未执行远控实机测试或验收，也未发布 Release。开发签名密钥只在开发启动时生成，安装包制作不会注入开发信任。

## Web 下载入口与桌面更新（0.12.0-alpha.1）

登录页品牌区、主界面侧栏快捷区、个人中心版本下方共用一个入口。Web 显示「下载桌面端」；桌面显示「检查更新」，有新版时改为「发现新版本」。弹窗使用现有蓝色主题和 Naive UI 卡片、按钮，展示内测版本、平台与文件大小、安装步骤、加载/无版本/错误重试状态。

`GET /api/desktop/release` 无需登录，服务端从固定的 `SSQLQIANBB/nearlink` 仓库查询公开 Release（最多最近 300 条），缓存 10 分钟，合并并发请求，失败后退避 30 秒。不能使用 GitHub `/releases/latest`，因为产品处于 alpha prerelease 阶段。只选择 `desktop-vX.Y.Z-alpha.N`，按数字语义版本排序，排除草稿、缺少任一平台安装包或 SHA256SUMS.txt 的版本；校验附件名、上传状态和固定仓库下载地址。不把 Actions 产物或草稿当作已发布下载。

浏览器只对能识别的 Windows x64 自动选择；Mac 的 UA 隐藏实际芯片，不把 `MacIntel` 当作 Intel 硬件证据。Mac 用户根据「关于本机」选择 Apple / Intel，手机、Linux、无法识别的架构均不默认选包。桌面端通过受主窗口权限约束的原生命令读取客户端编译架构与安装版本，避免 UA 误判；Rosetta 下按当前客户端架构推荐，也允许手动切换。

桌面启动后检查一次，返回窗口焦点时最多每 6 小时检查一次；手动入口立即检查。有更高版本时右下角显示非阻塞提示，可选择「稍后」，本次进程不再提示该版本。没有新版、处于开发中更高版本、查询失败均不会显示虚假的更新成功。关闭弹窗不退出应用，下载不停止任何会话。旧客户端没有这些新入口，须先手工安装一次包含本功能的版本。

当前更新采用安装包覆盖安装：Windows 由系统浏览器下载 NSIS exe，用户结束会话并从托盘退出后运行；macOS 下载 DMG，退出后拖入 Applications 替换。原生命令只允许构造固定仓库、固定平台、合法 alpha 版本的 HTTPS 安装包地址，不接受任意 URL、路径或 Shell 命令；不会自动执行下载文件。覆盖安装与权限迁移仍须使用实际安装包验证，不能承诺所有历史版本可无缝迁移。

后续如需应用内自动下载、验证、安装和重启，需接入 Tauri updater：建立独立更新签名密钥并将公钥编入客户端，私钥保存在 CI Secrets；生成签名文件、macOS app.tar.gz 与更新清单，安装包和签名全部上传后才公开清单；客户端验证签名并在空闲且用户确认后安装。当前流水线只有 exe/dmg 和 SHA-256 文件，SHA-256 校验文件不能代替 updater 签名，因此此版不展示「一键自动安装」。官方依据：[Tauri 更新插件](https://v2.tauri.app/zh-cn/plugin/updater/)、[GitHub Releases API](https://docs.github.com/en/rest/releases/releases)。

本批已做下载/更新逻辑的针对性检查和浏览器页面验证，不代表 Windows/macOS 覆盖安装或远控验收完成。发布仍保持草稿，需另行明确发布后，Web 才会推荐新包。

### 设备初始化不依赖电脑时钟（0.12.0-alpha.2）

设备登记和身份识别挑战不再在前端、原生签名层用客户端日期判断到期；前端保留字段、账号、登录会话和用途校验，原生保持限定用途签名，使用单调计时限制密钥访问操作。服务端仍用自己的时间校验 30 秒有效期，并通过 Redis TTL、一次性消费拒绝过期或重放。不会改写服务端发出的 expiresAt 或签名内容。该修复不改变远控会话授权、签名密钥有效期和媒体租约的时间校验，因此不表示任意系统时间下整个远控链路都能运行。需要重新构建、安装新桌面版本才会更新原生检查；更新网页不能修复已安装的旧程序。

### Windows 连接后在线状态更新失败的诊断（0.12.0-alpha.3）

`remote_control_presence` 会重新校验随包引擎目录；此前将所有校验失败统一映射成 `REMOTE_ENGINE_NOT_READY`，不能据此判断进程退出或引擎未安装。新版本保留失败关闭逻辑，区分编译清单不匹配、文件内容变化、清单外资源、不可读取和文件类型/权限异常；不会省略完整性检查或忽略失败的心跳。

旧版可将 `scripts/diagnose-remote-engine-windows.ps1` 复制到 Windows，在已打开 NearLink 后运行 `powershell -NoProfile -File .\diagnose-remote-engine-windows.ps1 -Samples 20`，同时重现连接。脚本从正在运行的程序定位安装目录，重复检查磁盘清单、文件大小、SHA-256、额外文件/目录及读取错误码；不修改文件或权限，不启动引擎，不执行采屏。若未能自动定位，可传入 `-InstallDir` 指定安装目录。脚本只比较磁盘清单，不能证明与 exe 内嵌清单一致；全通过时仍需新版本的精确错误分类，不能将其当作完整远控验收。脚本当前未在真实 Windows 设备执行验证。

### 引擎启动失败可重试与发布测试修复（0.12.0-alpha.4）

首次启动探测失败不再被永久缓存：失败后冷却 5 秒可重新检测，并发刷新合并为一次探测；成功结果继续缓存。实际会话启动和在线证明仍重新校验完整引擎资源，不改变权限与授权门禁。页面展示启动超时、握手失败、通信关闭及资源校验的具体错误码；这项改动修复重试和诊断，不表示已确认 Windows 启动失败的具体根因。

登录页增加下载入口后，原有测试依赖“页面第一个按钮”而误点击下载按钮。改为按“登录”按钮文本定位，保留重复提交保护和失败恢复断言。旧发布标签不移动，使用新的 alpha 标签触发构建。
