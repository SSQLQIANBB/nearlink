# 远控复用 TURN：接口、接入与部署核对

当前源码 `0.5.0-beta.2`，构建号 9。2026-09-27 已核实 `turn.sycsq.top:3478` 使用固定账号 `lt-cred-mech`，不能验证 REST 短期凭据。目前已显式配置 `static` 兼容模式复用该服务，原视频配置未改动；Ed25519 签名身份已在服务器生成，公钥编入本机新客户端。默认仍为 `rest`，不存在自动降级。

## 2026-09-27 产品联调部署

- 后端、Web 使用 `remote-preview-20260927` 镜像（0.5.0-beta.1），本机客户端已更新至 `0.5.0-beta.2`。服务端健康检查与数据库结构迁移通过，部署前完整数据库备份位于 `/opt/todesk/backups/schema-20260927T090901Z-remote-preview-20260927`。
- `REMOTE_CONTROL_PREVIEW_USER_IDS` 仅允许明确指定的现有账号，最多 20 个。REST 能力、Socket 准入和活跃会话授权均检查范围；未配置时全部关闭。仅提供 macOS 被控候选，Windows 未开放。
- 原生能力不再使用写死的假值：校验完整固定引擎文件树、建立认证 IPC、接收真实 `ready` 且确认未采屏，再终止探针。只有成功才报告 `engineReady`，系统权限另行预检，实际会话仍须原生确认、DTLS 绑定和续租。
- 当前联调强制 `relay`。原生 GStreamer ↔ Chromium 已分别实测公网 UDP、TCP 中继成功，DTLS 和两个 DataChannel 打通；该探针未采屏、未注入输入，不能当作产品远控验收。
- 用户已开启 macOS 屏幕录制/辅助功能并重启。真实客户端已完成设备登记、签名在线证明与 15 分钟临时许可；生产网页发现该在线设备并发起观看请求。17:40:42 请求进入 `pending`，45 秒内未完成本机确认，17:41:28 已结束，未进入传屏/输入阶段。
- `0.5.0-beta.2` 修复窗口切换时能力刷新清空设置面板的问题；授权弹窗附着到真实主窗口并在已验证请求后置前，超时给出明确提示。未完成用户确认前，不将 TURN 探针、设备在线或打包成功计为产品远控验收。

- beta.2 已安装并正常恢复登录；更新后原生检测再次报告未获得屏幕录制权限，已请用户重新确认当前应用的系统权限并重启。临时签名的应用身份随构建变化，不能把旧版本获权当作新版本获权。
- 本次前端 59 文件 / 281 测试、Rust 122 测试通过（2 项环境测试忽略），桌面生产构建、版本同步、完整签名检查通过。安装包 `ToDesk_0.5.0-beta.2_arm64_20260927.dmg` 的 SHA-256 为 `4880779472d534a2b93df3f2e1ab4bc932f0e42d61ec25b8af17928acf476288`。旧 beta.1 备份位于 `~/Library/Application Support/ToDesk-local-backups/20260927-1748/ToDesk.app`。新确认弹窗与完整产品会话仍待实测。

### 两种 TURN 认证方式

`REMOTE_TURN_AUTH_MODE=rest`（默认）：填写 `REMOTE_TURN_SHARED_SECRET`，coturn 使用 `use-auth-secret`，按会话签发下文描述的短期凭据。

`REMOTE_TURN_AUTH_MODE=static`（兼容现有服务）：在服务器私有环境文件填写 `REMOTE_TURN_USERNAME` 与 `REMOTE_TURN_PASSWORD`。每次读取仍检查会话、登录、设备、协助许可，并对配置签名；账号密码仅通过已认证、已授权会话接口交付。`expiresAt` 表示签名配置的有效期，**静态 TURN 密码本身不会随会话过期**，有中继凭据泄露和独立带宽滥用风险。远控媒体和输入的授权仍由本机确认、绑定 DTLS 的签名和 15 秒原生租约控制，TURN 密码不提供控制权限。缺失配置直接失败，不回退到另一认证方式。

服务器已准备独立短期认证监听 `3480/TCP+UDP`、中继 `49261–49360/UDP`，但外网测试超时且云 API 无 ECS 管理权限；当前该独立服务停用，避免留下一条误认为可用的路径。云侧放行后，可运行 `deploy/configure-remote-control.py --public-ip <公网IPv4> --private-ip <内网IPv4>`，复用已生成密钥并切换 `rest`，重建后端并重新做强制中继测试。该脚本不修改或重启原视频 coturn，也不自动开放远控账号。密钥只写服务器受限文件，输出仅包含公钥与配置位置。

## 已实现

`GET /api/remote-control/sessions/:id/ice` 使用现有 Bearer 登录认证，并要求：

- Redis 中存在当前 `connecting/active` 会话且已接受，连接期限和会话期限未到；请求的 `userId/sid/authVersion` 与其中一端完全匹配。
- 数据库重新检查两端账户版本、登录、设备和临时许可撤销状态。检查后重新读取会话，端点换代、状态结束或修订变化均拒绝签发。
- 配置有效且 Ed25519 签名密钥窗口足够。返回 `Cache-Control: no-store`，不在日志记录密码、共享密钥、候选内容或签名载荷。

响应包含 `iceServers`、`iceTransportPolicy`、`expiresAt` 和 `proof`。后者采用现有 `rc-signed-v1` 签名格式，`audience=todesk-native-ice`、`purpose=ice-config`，绑定 sessionId、两端全部身份字段、issuedAt、sessionExpiresAt 和同一份 ICE 配置。该证明不能作为 connection 或 lease 凭据使用。

TURN 用户名为 `到期秒数:rc:不透明端点标识`；密码为共享密钥对完整用户名的 HMAC-SHA1，再 Base64 编码。到期固定为 `floor((hardDeadline + 5分钟)/1000)`，重试不延长，用户名不包含账户或登录 ID。会话结束时本地立即停止媒体、释放连接；TURN 端已有 allocation 的释放时间另受其协议和配置控制，凭据到期不等于立即撤销已建中继。[coturn 官方认证说明](https://github.com/coturn/coturn/blob/master/README.turnserver)

浏览器在创建 PeerConnection 前验证地址格式、凭据字段和覆盖整场会话的有效期。支持 `all`（直连优先、TURN 后备）与 `relay`（强制中继），跳过原生不解析的 `.local` mDNS host 候选，保留数字 host/srflx/relay。

原生 `PreparedHost::configure_ice` / `HostTransport::configure_ice` 先使用内置公钥验签，再比对本机同意的会话及端点和单调截止时间；仅允许在首次 offer 前配置一次。配置经认证的继承管道传给 GStreamer；不经进程参数、环境变量或日志。引擎应用 STUN、多个 TURN URL 和策略后回报无凭据的 `network-configured`，原生收到该事件后才接受 answer。未提供配置仍是原有回环测试模式；错误配置不会自动退回回环或固定密码。

GStreamer URI 转换会分别转义用户名中的 `:` 及密码中的 `+ / =`。`turns:` 只接受 TCP；是否能连通还取决于服务端 TLS 监听与证书。[GStreamer 官方 TURN 配置说明](https://gstreamer.freedesktop.org/documentation/webrtc/index.html#webrtcbin:turn-server)

## 核对现有服务，无需在聊天中发送密钥

1. 在部署机器上确定实际运行的 TURN 软件、版本、加载的配置文件，以及容器/服务管理器是否覆盖配置。仅查看文件名、参数名和是否设置；不要粘贴完整配置、启动环境、数据库密码或启动命令中的 secret。
2. 检查有效配置是否开启 `use-auth-secret`，以及是否配置 `static-auth-secret` 或数据库 `turn_secret`。若已开启，在服务器内部把同一份 secret 注入后端 `REMOTE_TURN_SHARED_SECRET`，本实现要求 32–1024 字符。若是 `lt-cred-mech` 加固定 `user`/用户表而没有 REST 认证，固定密码不能用来生成 REST 临时凭据。
3. 如当前仅支持固定账号，先在测试配置中核对该 coturn 版本与现有账号的兼容性，再制定认证迁移。不要直接覆盖或切换线上认证。可继续共用已有主机及网络资源，必要时先隔离监听/实例验证；本轮没有改动或重启线上 TURN。
4. 核对 3478 UDP/TCP、实际 relay 端口范围及服务器 NAT 映射；TURN TLS 只在监听、证书与域名均正确时加入 `turns:域名:端口?transport=tcp`。HTTPS 域名可访问不能替代 TURN 检查。核对双方系统时间，避免时间戳凭据被提前判过期。
5. 按下面表格配置后端；Ed25519 公钥同时须进入原生可信密钥发布配置。仅 `/signing-keys` 返回了公钥不会让原生自动信任它。
6. 用已接受且仍存活的测试会话获取 ICE 响应。分别只保留 UDP、TCP、TLS（若部署）的一条 TURN URL 做强制 relay 验证，再恢复 `all` 验证局域网/跨 NAT。旧登录、已撤销设备/许可、未接受和已结束会话应拒绝签发；最后重新测试视频通话。

| 后端变量 | 配置说明 |
| --- | --- |
| `REMOTE_TURN_SHARED_SECRET` | 必填才可签发，纯服务端；不是客户端 TURN 密码 |
| `REMOTE_TURN_URLS` | 逗号分隔 1–4 个地址，默认现有 3478 UDP/TCP；明确填写 transport |
| `REMOTE_STUN_URL` | 默认同域名 3478；空字符串禁用；relay 策略不下发 STUN |
| `REMOTE_ICE_TRANSPORT_POLICY` | `all` 或 `relay`，默认 `all` |
| `REMOTE_CONTROL_SIGNING_KEY_*` | 既有 Ed25519 部署密钥和 Unix 毫秒窗口，至少覆盖本次会话结束及 5 分钟余量 |

目前 URL 支持域名或 IPv4 字面量；不支持 IPv6 方括号形式的服务器 URL。ICE 候选支持数值 IPv4/IPv6。

缺失 TURN secret 返回 `503 REMOTE_ICE_UNCONFIGURED`，地址/策略配置不合法返回 `503 REMOTE_ICE_CONFIGURATION_INVALID`，缺少签名密钥返回 `503 REMOTE_SIGNING_UNAVAILABLE`，签名窗口不足返回 `503 REMOTE_ICE_SIGNING_WINDOW`。非参与方为 403，不存在为 404，不可签发状态为 409。密钥未确认时不会伪装成连接成功。

## 可复用的原生 relay 验证脚本

先构建仅开发使用的原生入口：

```sh
cargo build --manifest-path client-vue/src-tauri/Cargo.toml --features remote-control-harness --bin remote-control-host-harness
```

`scripts/remote-control-turn-probe.mjs` 从 stdin 接收一个 JSON，格式为 `{"iceServers":[{"urls":["一条TURN地址"],"username":"临时用户名","credential":"临时密码"}]}`。使用本机受限临时文件或内部管道传入；不要把 JSON 直接写进命令行或提交仓库。输入文件只包含短期客户端凭据，不需要共享密钥。

```sh
REMOTE_CONTROL_PROBE_PYTHON=/path/to/gstreamer-sdk/bin/python \
  node scripts/remote-control-turn-probe.mjs < /private/path/ice-probe.json
```

脚本使用公开测试签名密钥和本地测试同意，验证原生签名配置、真实 GStreamer / Chromium ICE、DTLS 和两条 DataChannel，读取选中的候选对而非仅以“收到了 relay 候选”判成功。不会发媒体租约，不启动屏幕源或 OS 输入。输出仅有类型、协议和退出结果，不输出地址、凭据、完整 SDP。凭据必须在脚本完成期间有效；分别以单个 UDP/TCP URL 运行。它不能证明生产账号授权、两台电脑互连或完整安装包已通过验收。

## 本轮验证与边界

| 验证 | 结果 |
| --- | --- |
| 后端 | 24 文件、158 测试通过，含真实 HTTP、HMAC/签名、登录隔离、授权撤销、检查期间换代、固定到期与配置错误 |
| 前端 | 57 文件、269 测试通过；前后端类型检查通过 |
| Rust | 121 测试通过，2 项环境测试忽略；含错误签名/会话/端点/用途/有效期、配置重放、引擎确认及候选过滤 |
| Python 引擎 | 31 项引擎测试通过，含 IPC 的 Python 总计 38 项通过；含时间戳和 Base64 转义、配置顺序、候选策略与不启动媒体 |
| 现有公网 TURN UDP | 真实 GStreamer ↔ Chromium，双方选中 relay，`relayProtocol=udp`，DTLS + 双通道成功，原生/引擎退出成功；无采屏、无 OS 输入 |
| 现有公网 TURN TCP | 同上，`relayProtocol=tcp`；无采屏、无 OS 输入 |
| 错误 TURN 密码 | 强制 relay 无法建立并超时，未启动采集、未回退直连，原生/引擎均退出 |
| WK 回环媒体回归 | 授权前零帧，真实屏幕 H264 1280×720 首帧约 867ms，停止约 111ms，停止后帧不再推进，采集/引擎退出 |

公网两次验证使用现有视频通话配置中的客户端凭据，只证明服务及远控网络栈可共用。**尚未确认线上 REST shared secret，因此未声称新签发的短期凭据已在现网通过。** TLS、两台不同网络电脑、断网/防火墙/短期凭据自然过期、媒体质量等仍待联调。前端生产构建、版本来源检查与 10 项版本/发布测试也已通过。

2026-09-27 已补产品被控 Socket 适配器、真实登录/设备证明、临时协助许可与原生启动传输泵，详见 [产品接入进展](plans/2026-09-25-remote-control-implementation.md)。同日已部署限定账号的产品联调版本，状态见本文首节。上表为此前网络栈验证记录，不能代替产品实际画面/输入/停止验收。

## 2026-09-27 晚间产品实测

beta.2 的 macOS 录屏开关显示开启，但原生检测仍拒绝。已在不修改应用签名的情况下，使用系统 `tccutil reset ScreenCapture top.sycsq.todesk` 清理该 bundle ID 的录屏授权，并通过系统设置文件选择器重新添加准确路径 `/Applications/ToDesk.app`；重启后原生录屏检测恢复，设备能够上线。未修改其他应用或辅助功能权限。

新原生确认 sheet 已实际显示请求账号、会话和仅查看范围。确认后进入连接协商，但主控报 `REMOTE_PROOF_EXPIRED` 并结束，尚未取得产品画面。服务端与本机时间实测相差约 100 毫秒。网页新增一次 250 毫秒等待后重新严格验签的逻辑，不放宽签名时间检查，不延长到期或原生租约；真正过期、等待期间结束、用新时钟重验的测试均覆盖。已部署网页镜像 `remote-clock-20260927`，后续实际确认后不再停在此前的浏览器错误，但原生被控端主动结束；尚未取得画面。

网页失败状态现在保留代码并可关闭；不展示任意异常正文。后端增加受限的命令拒绝码与调用端结束码日志，不输出信令、凭据或签名载荷。生产联调覆盖文件 `/opt/todesk/docker-compose.remote-web.yml` 固定当前诊断镜像，配合原生产 Compose 与环境文件使用；桌面已安装二进制保持不变，避免再次使 TCC 授权失效。

继续排查时发现桌面桥接层隐藏了原生停止代码。0.5.0-beta.3（构建 10）补充受限的错误码展示及原生进程结束诊断；不输出引擎 stderr、SDP 或凭据。主控全部 285 项测试、后端全部 181 项测试与类型检查通过；新增被控端代码展示/敏感异常过滤后，该文件 8 项测试通过。新桌面包已构建并安装至 `/Applications/ToDesk.app`，深度签名检查通过，原生 122 项测试通过、2 项环境测试忽略。旧 beta.2 包备份于 `~/Library/Application Support/ToDesk-local-backups/20260927-beta2-before-diag/ToDesk.app`。新包录屏能力检测可用，但未完成实际媒体传输验收。

升级 beta.3 后，设备上线等待超时。对应用进行只读线程采样发现多个工作线程阻塞在 `SecItemCopyMatching` / SecurityServer 读取设备身份钥匙串，系统 SecurityAgent 正在运行。CUA 明确禁止操作 SecurityAgent，已请用户在系统界面核对应用并亲自完成钥匙串授权；没有读取钥匙串内容、绕过授权、改写 ACL 或更换设备身份。此阻塞解除之前暂停重复发起，不能声称远控已连通。新增服务器 `remote_presence_rejected` 受限诊断已部署，健康检查恢复 ready。

用户完成钥匙串授权后，beta.3 设备在线证明恢复，网页能够发现设备。19:48 左右实际请求 `8964d94b-d7f1-412a-8677-a7735d12e358` 完成本机仅查看确认；原生日志明确记录 `REMOTE_INPUT_UNAVAILABLE`。该错误发生在已观察到原生 DTLS、准备连接运行时的输入执行器构造阶段，尚未开启媒体。根因是 `MacOsInputExecutor::new_primary_screen` 使用了包含 AX 权限检查的布局读取，误阻断仅查看会话。beta.4 改为仅在构造时读取屏幕几何，输入 preflight 和每次事件发送仍检查 AX。新增查看无需输入权限、控制缺少输入权限必须终止的回归测试；原生 123 项通过、2 项环境测试忽略。修复包构建中，仍待实际画面及停止验收。

beta.4 同时补齐原生连接/租约凭据的微小时钟差处理：先用固定公钥验证签名，只对已签名且最多超前 250ms 的签发时间等待，随后仍以新的墙钟和单调时钟执行原有完整校验。未更改到期时间、许可范围、重放检测或原生 watchdog；超出 250ms 或签名无效直接失败。124 项原生测试通过、2 项环境测试忽略，覆盖签名无效、等待边界和仅查看/控制权限隔离。

beta.4 已完成安装，应用与 DMG 保存在 `/Applications/ToDesk.app` 和 `~/Downloads/ToDesk_0.5.0-beta.4_arm64_20260927.dmg`，应用深度签名验证通过；按用户要求把 beta.3 旧应用与安装包移至废纸篓。新签名启动后录屏能力检测仍可用，但上线再次阻塞于 `SecItemCopyMatching`，只读采样已确认，已请用户为 beta.4 完成系统钥匙串授权。此次停止点属于系统授权；尚未验证 beta.4 实际画面和停止释放，不应宣称已接通。

用户完成 beta.4 钥匙串授权后继续真实请求。首次出现 `GSTREAMER_PIPELINE_FAILED`，产品主控允许 VP8、原生仅输出 H264，与此前仅 H264 的引擎探针存在差异。已把产品主控协商收紧到原生实际支持的 H264 42e01f / packetization-mode=1 并部署网页；随后未再观察到同一管线错误，但仍在完成握手前被主控 `REMOTE_HEARTBEAT_TIMEOUT` 中止，未进入 active。进一步将主控的 3 秒心跳计时起点改为经过验证的 hello，握手前仍受原有 30 秒/凭据到期上限约束；握手后的 3 秒断线保护不变。全量前端 288 项及新增握手场景所在文件 27 项分别通过，生产构建通过。当前安装的 beta.4 桌面包包含原生修复；其内嵌主控页面尚未重打编码与握手这两项后续网页修复。仍未取得稳定产品画面，不能宣称端到端已完成。

0.5.0-beta.5（构建 12）继续修复数据通道首次握手竞态：GStreamer 1.28 的 `prepare-data-channel` 回调同步注册接收函数，避免原先 `on-data-channel` 排入 GLib 队列后漏收已到达的首条 hello。消息仍有界排队并由 Rust 校验，可靠/有序/标签/重复通道限制保留；回归测试覆盖队列尚未运行时立即到达的 hello 及重复/本地通道拒绝。另记录原生 watchdog 的固定枚举停止原因。引擎 32 项、原生 124 项（另 2 项环境忽略）、前端 289 项通过。此次安装包同时纳入此前网页的 H264 与握手等待修复；构建及实际联调结果待后续记录。

beta.5 已构建并安装到 `/Applications/ToDesk.app`，DMG 为 `~/Downloads/ToDesk_0.5.0-beta.5_arm64_20260927.dmg`，深度签名检查通过，beta.4 应用与下载包移至废纸篓。新引擎 manifest SHA256 为 `0878ff0c2fc63cbf3371b08eaa56cc2ed22cf5ee6bd7bafba943c57673296a45`，653 文件、72 原生文件，原位置/迁移位置启动与停止、拒绝开发参数、环境变量隔离检查通过（零录屏帧）。真实产品上线再次因钥匙串授权等待失败：只读线程采样确认 `SecItemCopyMatching` / SecurityServer 阻塞。用户虽允许输入现有密码，CUA 对 SecurityAgent 的工具限制仍不能绕过，已请用户在系统界面授权 beta.5。当前尚未验证首条 hello 修复后的产品实际画面。

用户完成 beta.5 钥匙串授权后，网页重新识别在线设备，真实连接在引擎报告 `INVALID_DATA_CHANNEL` 后结束。核对 GStreamer 1.28 源码发现远端 `prepare-data-channel` 发生在 DCEP 填入 label 等属性之前；beta.5 的属性校验时机过早。beta.6（构建 13）保留 prepare 阶段安装接收函数，将完整属性校验移至 on-open，接收消息还须匹配已校验的通道对象。33 项引擎单测通过；新增 `scripts/remote-control-channel-probe.py` 用真实 GStreamer 双端、仅回环网络验证：prepare 时 label 为空，双通道打开后立即发出的两条首消息完整收到，open IPC 在对应消息之前，无录屏或系统输入。探针运行命令为 `/tmp/todesk-gstreamer-m0-1.28.7/bin/python scripts/remote-control-channel-probe.py`（依赖临时固定版本 SDK）。该结果仍不是产品画面验收。

beta.6 已安装至 `/Applications/ToDesk.app`，下载包 `~/Downloads/ToDesk_0.5.0-beta.6_arm64_20260927.dmg`，深度签名验证通过，beta.5 已移至废纸篓。引擎 manifest SHA256 为 `45acb010f4c1caaee8ee96b532cfa36257cc008370f50f62d94de801cf87832b`，653 文件、72 原生文件，迁移及停止检查通过。

**产品画面首次确认：** 同账号 Chrome → 本机 Mac beta.6，沿用生产 relay 配置。网页实测显示 15 fps、约 1183–1559 kbps、RTT 71–73ms；原生采屏子进程持续运行约 39 秒。用户明确反馈“能看到正常桌面画面”。会话 `1e802e12-7f2a-48c6-8647-71f96ca0a514` 与 `fb2c2ef0-c10d-4b3d-9e76-773ff6af3e67` 均达到 revision 4，随后结束。进程检查确认采屏及引擎均退出。该结果证明产品仅查看链路已获得真实画面，但不证明跨两台物理电脑或键鼠控制。

**剩余验收：** 上述会话约 51–52 秒结束，原生日志依次出现 `REMOTE_AUTHORITY_EXPIRED`、`GSTREAMER_PIPELINE_FAILED`，主控曾报告 `REMOTE_VIDEO_FROZEN`。后续会话 `a3b90f47-d552-44e9-8ecf-a26532efddd0` 原生 watchdog 报 `MediaStalled`。已询问用户前两次是否手动结束/重连，尚未得到答复；不要把这些退出直接认定为正常主动停止，也不要声称长时间稳定性通过。需要在不切走主控画面的受控测试中复核媒体进度及停止释放，保留现有失活保护。键鼠控制尚未验收。

## 0.5.0-beta.7 协助时长及键鼠权限入口

新增 15 分钟、1 小时、长期有效三档请求许可，默认仍为 15 分钟；长期使用 NULL 到期时间，显式撤销/退出授权登录/设备撤销仍生效。已有同设备、同账号、同登录许可再次提交会更新时长，保留许可 ID。该修改不延长单次会话的一小时硬上限、不延长 15 秒媒体租约、不自动授予键鼠权限。

受支持的客户端默认提供键鼠控制入口，缺少系统输入权限时入口可见但不可用，显示原因。客户端增加辅助功能/屏幕录制设置入口和重新检测，原生打开设置命令限定主窗口与两条固定系统 URL，不能授予权限或执行输入。仅观看不再显示恢复键鼠操作提示。真实键鼠操作仍须本机同意、系统权限、有效租约和正常画面共同满足；本轮自动测试不能替代实际输入验收。

beta.7（构建 14）已安装至 `/Applications/ToDesk.app`，深度签名验证通过，安装包位于 `~/Downloads/ToDesk_0.5.0-beta.7_arm64_20260927.dmg`。用户完成辅助功能授权后，安装包实际显示“系统权限已就绪，对方可以请求控制”；设置下拉框已核对三档许可均存在，未创建长期许可或勾选记住授权。默认连接仍需本机确认；另行显式选择记住授权的行为见 [记住授权设计](remote-control-remembered-consent.md)。

后端及网页已部署 `remote-beta7-20260927`，数据库备份位于服务器 `/opt/todesk/backups/beta7-20260927T135412Z`，迁移及迁移检查成功，健康检查 ready。最终后端 182 项、前端 292 项、原生 130 项测试通过，另 2 项原生环境测试忽略；独立 MySQL 集成测试未运行，生产迁移检查不能替代该测试。当前已验证系统权限识别与设置展示，尚未完成跨电脑真实键鼠操作及长时间稳定性验收。

## 0.5.0-beta.9 修复一分钟自动断开

生产引擎误带开发期 60 秒退出条件。beta.8 诊断复现停止时，心跳正常且租约尚有 14.6 秒，最终定位到 `DEVELOPMENT_ENGINE_TIME_LIMIT`。beta.9 移除此条件，保留原有一小时会话上限、短租约及心跳/媒体失活检测。引擎 34 项测试通过，包含虚拟时间连续续租 30 分钟及真实保护到期回归；原生 130 项通过、2 项环境测试忽略，版本发布 10 项通过。

新引擎 653 文件、72 原生文件，manifest SHA256 为 `876af14fa532fdde760be70bc2c5f8b498bdd3a7580b90db2e482e3ee44b9fd9`。资源校验、迁移启动/停止、开发参数拒绝与环境隔离检查通过。此处测试记录不代表真实 30 分钟稳定性验收。

**beta.10 补充修正：** beta.9 只移除了 Python 引擎 60 秒限制，实测仍断开，不能视为完整修复。继续排查发现 Swift 采屏程序的 `reason()` 还包含 45 秒 `PROBE_TIME_LIMIT`，与约 48–52 秒会话结束吻合；beta.10 一并移除该生产路径限制。保留监督心跳 3 秒、采屏失活 12 秒后备保护以及原生租约/媒体失活检查。诊断同时在认证 IPC 接收端记录受限的终止枚举，避免被原生健康检查抢先结束而丢失错误原因。另一次用户输入测试记录 InputExpired，属于单独待复核的输入事件有效期问题，不能宣称全部断开原因已消失。

最终 beta.10 引擎 manifest SHA256：`e734dbe6cf4cadc2736b334e98189230852269da1bbf77cffbe4842c30c2fd9d`。校验 653 文件、72 原生文件，迁移启动/停止及开发参数拒绝通过；最终安装包必须使用该清单，不能误用仅移除 Python 60 秒限制的 beta.9 引擎。

beta.10（构建 17）已安装至 `/Applications/ToDesk.app`，深度签名与包内最终引擎清单校验通过。DMG：`~/Downloads/ToDesk_0.5.0-beta.10_arm64_20260927.dmg`。旧 beta.9 保留在本机备份目录。等待最终版本实际连接超过 45/60 秒的复测，不能以 beta.9 的失败或自动回归结果代替此项。

**beta.11 输入过期修复：** beta.10 实测已跨过开发计时退出点，随后约 85 秒时由 InputExpired 终止，租约仍剩 14295ms，非开发计时器或授权到期。输入 guard 本来返回暂停及释放计划，但 HostRuntime 将其升级为整场停止；现改为丢弃过期输入、不 ACK、释放已按下的键鼠并暂停控制，保留有效媒体。仍需现有控制确认流程取得新授权后恢复，不复用旧输入票据。新增回归验证已按键释放、过期事件零执行/零 ACK、延迟事件继续丢弃、不能直接重启输入；原生 131 项通过、2 项环境测试忽略。beta.11 沿用最终 beta.10 引擎清单。

beta.11（构建 18）已安装至 `/Applications/ToDesk.app`，深度签名及包内引擎清单核对通过；安装包为 `~/Downloads/ToDesk_0.5.0-beta.11_arm64_20260927.dmg`。旧 beta.10 应用已备份，等待最终连续连接复测。

**beta.11 前台复测：** 用户确认前一轮曾切换窗口或重连，不能将该轮退出直接算作新的代码故障。重新要求 Chrome 持续前台后，2026-09-27 23:22:31 只读进程检查确认同一引擎已运行 3 分 45 秒、采屏进程 3 分 43 秒，期间无新增原生终止日志，跨过原 45/60 秒固定退出点。此证据支持开发期固定退出修复；用户视觉反馈另记，不代表真实 30 分钟或跨电脑稳定性验收。
