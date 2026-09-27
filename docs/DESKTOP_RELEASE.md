# 桌面版本发布

开发分支为 `feature/desktop-tauri`。桌面端使用独立的 `desktop-v` 标签前缀，避免与网页版本混淆。下载地址：<https://github.com/SSQLQIANBB/toDesk/releases>。

## 统一产品版本与提交规则

当前源码产品版本为 `0.5.0-beta.12`，处于内测阶段。根目录 `package.json` 的 `version` 是唯一维护入口，前端、后端、Tauri、Rust 包及 `Cargo.lock` 中的自有包版本保持一致。第三方依赖版本不加内测标识。界面、桌面窗口、托盘和 Release 说明显示“内测版”及完整版本；应用名与标识仍为 `ToDesk` / `top.sycsq.todesk`，保留原有安装路径和用户数据。

| 变更 | 版本操作示例 |
| --- | --- |
| 新增较大功能、重要协议或架构升级 | `0.2.0-beta.1` → `0.3.0-beta.1`，次版本递增，修订版本和 beta 序号重置 |
| 同一功能阶段的小功能、优化、尚未发布的修复 | `0.2.0-beta.1` → `0.2.0-beta.2` |
| 对已经分发的版本单独发布兼容性缺陷或安全修复 | `0.2.0-beta.2` → `0.2.1-beta.1` |
| 仅文档、测试整理且不产生新的分发包 | 可保留版本；不能复用已有标签覆盖安装包 |

大改动应在对应批次的中文提交中同时升级版本，不能到发布时才补版本。`0.x` 内测阶段的重要不兼容变更也递增次版本，并记录兼容性影响；未来结束内测或升主版本需另行明确，当前脚本拒绝不含 `-beta.N` 的正式版本。

```sh
# 一次同步所有版本来源，并自动递增 macOS 数字构建号
pnpm version:set 0.3.0-beta.1

# 保留当前版本与构建号，只修复来源不一致
pnpm version:sync

# 只读校验；本地构建、测试及 CI 也会执行
pnpm version:check
pnpm test:release
```

版本维护命令不创建提交或标签、不安装应用。重复设置同一版本不会增加构建号；拒绝版本回退。`version:check` 能检查来源是否一致，变更是否属于“大功能”仍由提交者与评审者判断。`pnpm-lock.yaml` 不记录工作区自身版本，本次版本升级无需改写依赖锁定结果。

## 系统版本字段

产品版本与安装包文件名保留 `0.5.0-beta.12`。macOS 的 `CFBundleShortVersionString` 要求三个数字段，`Info.plist` 因而显式写入 `0.5.0`；`CFBundleVersion` 使用根 `package.json` 中独立递增的 `desktopBuildNumber`（本版为 `18`），通过 `bundle.macOS.bundleVersion` 写入。完整内测版本仍在界面和 `CFBundleGetInfoString` 中展示。两项数字字段遵循 [Apple 短版本要求](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)和 [Apple 构建号要求](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)。

Windows 使用当前 Tauri 2.11.5 的 NSIS 默认流程：数字资源版本为 `0.5.0.0`，显示版本和安装包名保留 `0.5.0-beta.12`；安装升级比较完整语义版本，因此 beta 序号仍能区分升级。无需把预发布后缀塞入数字字段，也不改造默认安装模板。依据：[Tauri NSIS 数字版本转换](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.5/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs)、[默认安装模板与版本比较](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.5/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)。若以后切换 MSI，需要另行核对 MSI 版本限制。

## 一次发布的操作

1. 在该批功能提交前运行 `pnpm version:set <新的内测版本>`，并一起提交同步后的文件。首次统一版本为 `0.2.0-beta.1`。
2. 运行 `pnpm version:check`、`pnpm test:release`、相关功能测试和类型检查；用 `cargo check --locked --manifest-path client-vue/src-tauri/Cargo.toml` 核对 Rust 依赖。版本脚本直接同步本包的 `Cargo.lock` 条目，不会更新第三方依赖。
3. 提交并推送代码，再推送对应版本标签。以 `0.2.0-beta.1` 为例，在仓库根目录执行：

```sh
node scripts/desktop-release.mjs desktop-v0.2.0-beta.1
git push origin feature/desktop-tauri
git tag -a desktop-v0.2.0-beta.1 -m "发布桌面端内测版 0.2.0-beta.1"
git push origin desktop-v0.2.0-beta.1
```

当前发布一律标记为 GitHub Prerelease。已发布标签不可重复使用或移动；修复后请递增版本号。标签必须指向包含 `.github/workflows/desktop-release.yml` 的提交，无需先合并 master。普通分支推送不创建 Release。工作流由 GitHub 自带的 `GITHUB_TOKEN` 发布，不需要额外的个人访问令牌。

## 自动流程

1. 校验所有自有包、Tauri、Rust 锁文件、平台版本字段与标签是否一致，不一致时在构建前失败。
2. 运行前端测试、类型检查（打包前执行）、Rust 编译并构建三个安装包。Windows 还运行现有的 WebView2 原生测试。
3. 三个平台全部成功后，检查安装包数量并生成 `SHA256SUMS.txt`。
4. 创建 Release 草稿，附加所有安装包及 SHA-256 校验文件；上传全部成功后发布，避免用户看到缺少平台附件的正式版本。

失败的构建不会发布 Release。若上传阶段中断，可在 Actions 中重跑失败任务，流程会补齐同一个草稿的附件；已公开发布的版本不会被覆盖。

| 系统 | 下载文件 | 安装方式 |
| --- | --- | --- |
| Windows x64 | `ToDesk_0.5.0-beta.12_x64-setup.exe` | 运行安装程序 |
| Apple 芯片 Mac | `ToDesk_0.5.0-beta.12_aarch64.dmg` | 打开后拖入 Applications |
| Intel Mac | `ToDesk_0.5.0-beta.12_x64.dmg` | 打开后拖入 Applications |

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
