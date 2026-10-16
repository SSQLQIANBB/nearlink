# macOS arm64 远控引擎本地候选包

该入口把现有 Swift 屏幕源与 Python/GStreamer 引擎整理成一个可搬移、可核对文件清单的资源目录。它不是发布命令，不开启远控门禁，也不证明签名、公证、许可证材料或 macOS 13 实机验收已经完成。

## 构建和验证

构建机需要 Apple Silicon macOS、Xcode Command Line Tools、CPython **3.13.2**，以及安装 **1.28.7** 版本 `gstreamer_libs`、`gstreamer_plugins`、`gstreamer_plugins_libs`、`gstreamer_python` 的 Python 环境。脚本严格核对版本；这些是当前候选的固定输入，不表示建议长期使用该 Python 补丁版本。升级依赖时需重新生成清单并完成回归。

```sh
python3 scripts/package-remote-control-engine.py \
  --sdk-python /path/to/pinned-sdk/bin/python \
  --output dist/remote-control-engine-candidate

python3 scripts/verify-remote-control-engine.py \
  dist/remote-control-engine-candidate

# 只检查资源，不启动引擎
python3 scripts/verify-remote-control-engine.py \
  dist/remote-control-engine-candidate --static-only

# 显式把同一个完整资源包固定进桌面构建（默认 desktop:build 自动制作对应平台引擎）
VITE_API_BASE_URL=https://www.sycsq.top VITE_SOCKET_URL=https://www.sycsq.top \
node scripts/remote-control-desktop-build.mjs \
  --bundle /absolute/path/to/remote-control-engine-candidate \
  -- --target aarch64-apple-darwin
```

输出目录必须不存在，避免覆盖已选入客户端构建的候选。构建期解释器位置不限，运行期没有该路径依赖。构建过程只复制文件、检查库元数据和编译，不启动屏幕源。

验证脚本逐项核对文件大小、SHA-256、权限、独立普通文件、arm64 架构、最低系统版本、Mach-O 链接与本地签名；随后复制到包含空格的新目录，以空环境启动真实引擎，通过继承管道完成 MAC 认证的 `ready → stop` 和 `ready → EOF`。这两个场景不发送 offer 或媒体租约，不采屏、不开启 OS 输入。它还验证 Python 环境注入无效、固定入口拒绝开发参数、普通 Swift 二进制拒绝测试参数，以及运行后没有修改资源或生成 `__pycache__`。

## 资源和入口约束

资源根目录包括：

- `bin/remote-control-engine`：原生固定入口，嵌入隔离 CPython；不接受参数。
- `bin/remote-control-screen-source`：以 `arm64-apple-macos13.0` 编译的普通 Swift 屏幕源，不含 `REMOTE_CONTROL_TEST_FAULTS`。
- `app/`：固定引擎入口、引擎模块与纯 IPC codec。
- `runtime/`：裁剪后的 CPython、标准库和必要扩展，不带 pip 或独立解释器 CLI。
- `sdk/`、`typelib/`：实际依赖闭包、明确列出的 GStreamer 插件与 GI 元数据。
- `licenses/`：现有许可证材料、插件自报声明、依赖哈希和未完成事项。
- `manifest.json`：按路径排序的完整文件清单，不把清单自身列入 `files`。

入口通过自身位置定位资源，清空继承环境，关闭用户 site、`.pth`、字节码写入和环境变量配置；Python 模块、GI typelib、GStreamer 插件仅从固定资源加载。GStreamer 不启动外部插件扫描器，不写注册表缓存。GIO 的普通/额外模块目录和 OpenSSL provider 目录固定指向包内无模块目录，OpenSSL 使用包内空配置，避免库中编译进去的开发机默认搜索路径。除 Apple 系统库外，Mach-O 依赖均改成指向包内的 `@loader_path`；移除开发 SDK 的 `LC_RPATH`，裁剪为 arm64，并重新添加仅供本地执行的 ad-hoc 签名。

运行时不使用 `/tmp`、Homebrew、开发机解释器或可执行文件搜索路径。媒体仍须由 native supervisor 发送已验证的租约才能启动；已有 loopback ICE、心跳、绝对单调时钟截止时间、源进度、几何绑定与停止回收逻辑保持不变。当前屏幕源仍有 45 秒开发上限。

客户端必须将清单的精确内容固定进构建，并在固定 app Resources 位置验证整个目录；候选目录中的清单自身不能建立信任。文件内容变化、签名变化、增加/删除文件都需要重新生成清单并重建客户端。发布签名不能在客户端已经固定旧清单之后单独替换引擎文件。

构建 wrapper 生成临时 Tauri 资源映射，`build.rs` 验证完整目录并嵌入精确清单；运行时从 `AppHandle.resource_dir()` 下固定子目录加载，启动前复查全部文件。选中资源包时禁止启用开发 harness；没有选择时保持未配置。`spawn_bundled` 是原生内部接口，不提供通用网页启动命令，也不自动改变 capability。

本机最终候选包含 653 个文件、72 个 arm64 Mach-O，共 49,504,875 字节。完整闭包、权限、签名和搬移校验通过，运行后未改动资源。首次加载有显著的临时签名/dyld 成本：原位置冷启 34,189ms、热启 428ms；含空格的新目录冷启 19,366ms、热启 356ms。零采屏验证允许最多 45 秒观察启动，不能据此放宽产品建连、短租约或运行期间的 3 秒监督；冷启动不满足现有连接体验目标，仍是发布前需解决的问题。

## 依赖与许可证核对范围

构建不复制全部 SDK。当前显式插件为 coreelements、app、videoparsersbad、rtp、rtpmanager、nice、dtls、srtp、sctp 和 webrtc，其余动态库由 Mach-O 依赖闭包决定。`dependency-inventory.json` 记录每个实际复制的本机二进制的来源包、原始 SHA-256、最低系统版本和依赖；插件名称、版本、许可证声明直接读取选中插件，而不是由整个 wheel 的汇总字段推断。

依赖包含 CPython、PyGObject/GObject Introspection、GStreamer、GLib/GObject/GIO、libnice、libSRTP、OpenSSL、libffi、PCRE2、gettext/libintl、ORC、zlib，以及 Python 标准库扩展。精确文件以该次构建的清单为准；部分第三方组件版本和完整许可证文本不能仅从当前已安装 wheel 确认。

已附 CPython 安装中的 `LICENSE.txt` 和四个 wheel 的原始 `METADATA`。wheel 的汇总许可证字段不能证明裁剪后的每个动态库已经满足再分发条件。GStreamer 官方说明核心采用 LGPL，插件还可能受其外部依赖的许可证约束；Python 官方说明也要求保留相关许可证与第三方材料。见 [GStreamer 许可证说明](https://gstreamer.freedesktop.org/documentation/frequently-asked-questions/licensing.html) 和 [Python 3.13 许可证](https://docs.python.org/3.13/license.html)。

以下事项仍阻止将候选称为可公开分发的产品包：

1. 核对并补齐每个 vendored 库的准确版本、完整版权/许可证材料，以及与二进制匹配的必要源码和构建材料；不能把包级 `METADATA` 当作完整通知。
2. 完成依赖安全更新评估、Developer ID 签名、公证、hardened runtime 与嵌套资源的签名顺序验证。
3. 在干净的 macOS 13 arm64 主机验证实际运行、权限、编码、传输和停止；当前最低版本检查仅证明二进制声明与编译目标。
4. 扩展精确安装包的真实媒体回归，覆盖干净机器、停止/到期/断网、系统权限和产品授权。当前已用 `.app/Contents/Resources` 内实际资源通过 WKWebView 观看与控制记录链路：授权前零帧，控制首帧约 524ms、记录 ACK `[1,2,3]`、停止约 151ms，源/引擎退出；没有实际 OS 输入，仍由 debug supervisor 提供测试同意。这不等同于产品完整链路验收。

构建工具会把这些缺项保存在包内清单中；不会生成测试密钥、开启生产门禁、发布安装包或更改系统权限。
