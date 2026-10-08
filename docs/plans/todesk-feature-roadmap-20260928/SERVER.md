# 服务器、配置与发布实施方案

配套：[功能总表](./README.md)、[代码实施](./IMPLEMENTATION.md)。本文件提供实施设计与模板，**本次未修改生产配置、未执行部署、未验证线上资源**。示例域名/IP/密钥都是占位，须在运维实施时替换。当前源码支持的变量与尚需开发的参数明确分开。

## 1. 已有部署与目标拓扑

当前仓库部署链路：公网 Caddy → `web` 容器 Nginx → `backend:3000`；Nginx 转发 `/api/`、`/meeting`、`/connect`，不是默认 `/socket.io`。MySQL 8.4 和 Redis 7.4 使用独立 infrastructure Compose 的 `shared-services` 网络；后端还有 `todesk-internal` 网络。公共/私有文件使用七牛，Caddy 与 cert-sync 负责域名证书流程。相关文件：

- `docker-compose.prod.yml`、`docker-compose.infrastructure.yml`、`client-vue/nginx.conf`、`Caddyfile`。
- `.env.production.example`、`.env.infrastructure.example`、`backend-koa/src/config/env.ts`。
- `deploy/configure-remote-control.py`、`deploy/migrate-database.sh`。
- [原部署手册](../../../DEPLOYMENT.md)、[环境变量规范](../../ENVIRONMENT_VARIABLES.md)、[七牛与证书手册](../../QINIU_CDN_CERTIFICATE_AUTOMATION.md)。

S0/S1 保持一个活动 backend；媒体直连或 coturn，文件对象走 CDN。优先将 TURN 与控制面放不同主机/公网带宽池，防止大流量影响登录与续租。开始可以共机，但必须限制中继、文件流量并监控余量。

S2 先完成组织权限，仍可单实例。S3 在 W16 的所有权、fencing、跨实例路由完成后，才引入双 backend/负载均衡、独立 DB/Redis、多个 TURN 区域。可选 SFU、AI worker、录制归档处理器须经过对应功能原型后新增，不提前采购。

## 2. 资源规划与容量计算

以下是压测起点，不是已验证承载能力，也不是采购报价。并发连接需区分“在线 Socket”“活跃远控”“实际中继会话”“文件传输”，不能用注册用户数直接估算机器。

| 环境 | 控制面与数据 | TURN | 目标用途 |
| --- | --- | --- | --- |
| 开发/测试 | 4 vCPU / 8GB / 100GB SSD 起，独立测试 DB/Redis | 2 vCPU / 4GB，受限公网配额 | 2–5 活跃会话和异常注入；与生产隔离 |
| 内测起点 | 应用 4 vCPU / 8GB；DB/Redis 可同内网另 4 vCPU / 8–16GB，200GB SSD 起 | 独立 4 vCPU / 8GB；带宽按公式选，优先 200Mbps 起的压测档 | 约 20 活跃会话的测试目标，不保证全部高清视频中继 |
| 扩容参考 | 2 个应用节点各 4–8 vCPU / 8–16GB；DB 8 vCPU / 16GB 起；Redis 独立 | 多个节点，按实测单节点能力和故障余量分配 | 100+ 活跃会话需先完成多实例协议及容量测试 |

CPU 主要受信令、TLS、文件代理和中继包率影响；TURN 不解码视频，默认不需要 GPU。GPU 优先用于被控编码端，云端只有转码/AI 等需求明确后再评估。

### 2.1 带宽与流量

定义：N=活跃远控数，r=中继比例，b=每会话双向媒体/数据的有效总码率（Mbps），k=每会话在所计节点集合中的中继发送次数系数（单中继腿约 1、双中继腿可能接近 2，按实际拓扑测量），h=协议开销与容量余量（初估 1.3）。

`TURN 峰值发送预算 Mbps = N × r × b × k × h`。

例：N=20、r=50%、b=4、k=2、h=1.3，预算约 **104Mbps**；满 20 路都中继约 **208Mbps**。100 路、r=50%、相同假设约 **520Mbps**。这还不包含独立文件高峰和其它产品业务，因此不能以“服务器 100Mbps”承诺 20 路全部高清中继。另核对接收带宽、NIC 包率、云厂商限速方向及突发计费。

十进制出站流量：`GB/小时 ≈ 实际平均 Mbps × 0.45`。平均 80Mbps 持续 8 小时/天、22 天，约 6,336GB/月；不要把预算余量直接当实际流量。月成本按实际区域报价代入：计算实例+公网流量/带宽+磁盘/快照+对象存储/请求/CDN+日志+证书或签名服务。未指定云厂商/地域/可用性，不给虚构价格。

录像存储：4Mbps × 1 小时约 1.8GB，1,000 会话小时约 1.8TB，另加冗余/索引；默认本地录像不会自动产生云存储，但开启云归档前必须设置配额和保留期。

### 2.2 容量闸门

压测记录 allocation 数、实际 relay 端口占用、CPU、RSS、pps、发送/接收 Mbps、连接成功率和 p95 建连时延。端口范围不直接等于会话数：一个会话可能多个 allocation，传输复用和 ICE 实现影响实际占用。当前独立脚本仅 100 个 relay 端口，且 total-quota=128 是 allocation 配额，不能据此声称可承载 128 会话。

建议初始告警：带宽持续 5 分钟 >预算 70%、relay 端口/配额 >70%、CPU p95 >70% 或连接成功率显著下降，先降低新建配额/导流再扩容。保留单节点故障的剩余容量；仅增加第二节点而平时两台都跑满不构成冗余。

## 3. 域名、网络和防火墙

| 用途 | 建议名称/端口 | 暴露范围与说明 |
| --- | --- | --- |
| Web/API/WSS | `desk.example.com` TCP 443；TCP 80 按证书/跳转需要 | 公网；HTTPS 到 Caddy，保留原 Nginx 路由 |
| 当前视频 TURN | 现有 3478 UDP/TCP 和实际 relay 范围 | 按现有配置核实，不改它的认证或端口 |
| 独立远控 TURN（沿用脚本） | `turn-rc.example.com` 3480 UDP/TCP | 公网；DNS 直连公网 IP，不经普通 HTTP CDN |
| 独立远控 relay | 49261–49360 UDP（现脚本默认） | 云安全组+宿主机防火墙双处放行；增大范围时同步三处配置 |
| 后续 TLS TURN | `turn-rc.example.com` 5349 TCP，或独立 IP 的 443 TCP | 需要有效证书、TLS 监听和客户端实测；普通 Caddy HTTP 反代不能直接转发 TURN |
| MySQL | TCP 3306 | 仅应用/备份管理的私网来源，不公网映射 |
| Redis | TCP 6379 | 仅应用私网；逻辑 DB 不构成强隔离 |
| 运维 SSH/监控 | SSH 22、指标端口按实现决定 | 管理 VPN/堡垒机或来源白名单，禁止公网裸露指标/管理接口 |

TCP 客户端连接 TURN 并不意味着 relay 端口也只放 TCP；典型 WebRTC TURN/TCP 客户端仍使用服务器 UDP relay allocation，需照实际配置放行 UDP relay 范围。若后续启用其它传输模式，再按该模式明确开放。

云主机在 NAT 后：`external-ip=公网IP/内网IP`、`listening-ip` 与 `relay-ip` 用实际网卡 IP，要求端口一对一可达。不要将示例 IP 写入服务；先核对公网映射和路由。需要 IPv6 时同步 AAAA、IPv6 防火墙、coturn peer 策略及客户端解析；当前服务器 URL 解析限制见既有 TURN 文档，不能只加 AAAA 宣称完成 IPv6。

## 4. 配置归属与当前变量

真实值在服务器受限文件/密钥管理服务；仓库只提交 example。`.env.production` 与 `.env.infrastructure` 权限 600，备份目录 700；不输出完整环境、完整 `docker compose config` 或含私钥的命令行到工单。桌面 VITE 变量会进入用户包，禁止承载任何服务端秘密。

| 位置 | 当前已有配置 | 实施要点 |
| --- | --- | --- |
| `/opt/shared-services/.env.infrastructure` | MYSQL_ROOT_PASSWORD、INITIAL_DB_NAME/USER/PASSWORD、REDIS_PASSWORD | MySQL root 只管理基础设施；应用使用独立用户；先创建网络再部署应用 |
| `/opt/todesk/.env.production` | NODE_ENV、PORT、DB_*、REDIS_*、JWT_SECRET、REFRESH_TOKEN_SECRET | 生产关闭 DB_AUTO_CREATE/DB_SYNC_ALTER；JWT 与 refresh 秘钥不同；DB/Redis 地址对应私网别名 |
| 同上 | DOMAIN、FILES_DOMAIN、PRIVATE_FILES_DOMAIN、QINIU_*、ALIYUN_*、SMTP_* | 公共头像与私有文件分开；证书同步和 SMTP 连通性独立验收 |
| 同上 | REMOTE_CONTROL_PREVIEW_USER_IDS | 当前最多 20 个逗号分隔用户 ID；空值关闭入口；无空格，不误填用户名 |
| 同上 | REMOTE_TURN_AUTH_MODE、REMOTE_TURN_SHARED_SECRET、REMOTE_TURN_URLS、REMOTE_STUN_URL、REMOTE_ICE_TRANSPORT_POLICY | 默认 rest；relay 只用于强制中继验收/明确组织策略，通常恢复 all |
| 同上 | REMOTE_TURN_USERNAME/PASSWORD | 仅 static 兼容路径；不自动从 rest 回落；长期固定密码需退出计划 |
| 同上 | REMOTE_CONTROL_SIGNING_KEY_ID/PRIVATE_KEY/NOT_BEFORE/NOT_AFTER | Ed25519、毫秒时间窗口；私钥只留服务端；公钥进入客户端可信清单 |
| 桌面构建 | VITE_API_BASE_URL、VITE_SOCKET_URL、DESKTOP_SERVER_URL（发布工作流） | HTTPS 根地址，无 `/api`、`/meeting` 后缀；前两项具体注入按现有构建脚本 |
| 原生构建 | `client-vue/src-tauri/remote-control-trusted-keys.json`、TODE_REMOTE_ENGINE_BUNDLE | 固定可信公钥/有效期和匹配平台的引擎资源；动态取到公钥不代表可以自动信任 |

当前可用远控配置示例（非完整生产文件；密钥由服务器受限配置流程填写）：

```dotenv
REMOTE_CONTROL_PREVIEW_USER_IDS=
REMOTE_TURN_AUTH_MODE=rest
REMOTE_TURN_URLS=turn:turn-rc.example.com:3480?transport=udp,turn:turn-rc.example.com:3480?transport=tcp
REMOTE_STUN_URL=stun:turn-rc.example.com:3480
REMOTE_ICE_TRANSPORT_POLICY=all
# REMOTE_TURN_SHARED_SECRET 和 REMOTE_CONTROL_SIGNING_KEY_* 在服务器注入
# 留空预览账号，完成平台验收后再加入获准内测账号
```

远控配置有独立解析服务 `remoteIce.ts` / `remoteCredentials.ts`；不要因为基础 `env:check` 通过就认定 TURN/签名配置可用。需同时核对后端 capability、签名窗口及真实会话 ICE 接口。

## 5. TURN 实施步骤

历史记录 [remote-control-turn.md](../../remote-control-turn.md) 表明旧视频服务是 static 固定账号，独立 3480 REST 服务曾因云侧不通而停用。这是历史证据，执行前重新确认服务状态和安全组，不能认为已经修复。

1. 在测试环境核对 coturn 二进制版本、服务用户 `turnserver`、已有服务 `coturn`、实际监听/relay 端口、域名、NAT 和证书。固定已验证版本或镜像 digest，不在生产自动追 latest。
2. 保留旧视频 coturn，准备独立实例/监听和不重叠 relay 端口。云安全组与主机同时放行上述 3480 和 relay UDP；确认无冲突。
3. 备份现有 env 和 TURN 配置。现有脚本是**有副作用的配置工具**：写 `.env.production`、密钥与 systemd unit，并启用/重启独立服务，不是只读探针。它假设 Linux systemd、coturn、OpenSSL 和相关用户/目录已就绪，并检查旧服务也 active；不满足时先改造部署步骤，不盲目运行。
4. 运维实施时可复用命令（下列地址为文档占位，必须替换）：

```sh
sudo python3 deploy/configure-remote-control.py \
  --deployment /opt/todesk \
  --hostname turn-rc.example.com \
  --public-ip 203.0.113.10 \
  --private-ip 10.0.1.10 \
  --port 3480 \
  --relay-min 49261 \
  --relay-max 49360
```

5. 通过既有发布流程加载新后端配置，公钥进入客户端可信清单并发布匹配客户端；关闭全量入口，仅测试账号进行验证。脚本不会替你编译/部署客户端或开放账号。
6. 先探针，再真实产品会话；UDP、TCP 分别使用单一 TURN URL 和 `relay` 策略，检查**选中的 candidate pair** 是 relay、DTLS 和数据通道成功、真实采屏/鼠标/键盘工作。恢复 `all` 后测试 P2P 与不可穿透 NAT 的回退；回归旧视频通话。

### 5.1 coturn 配置模板

以下展示与当前独立实例一致的关键项，不能覆盖旧视频实例。占位秘密通过受限模板流程注入，不把 `REPLACE_...` 原样启动。

```ini
listening-port=3480
listening-ip=10.0.1.10
relay-ip=10.0.1.10
external-ip=203.0.113.10/10.0.1.10
realm=turn-rc.example.com
use-auth-secret
static-auth-secret=REPLACE_WITH_SERVER_ONLY_RANDOM_SECRET
min-port=49261
max-port=49360
fingerprint
stale-nonce
no-tls
no-dtls
no-cli
no-multicast-peers
# 公共中继不允许访问服务端可达的私有管理网络
# 若部署明确的企业内网中继，应单独设计允许列表，不能直接删除所有限制
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
relay-threads=2
user-quota=12
total-quota=128
```

quota 数字沿用脚本示例，不是容量保证；S0 初始限流应按少量预览账号控制，压测后按端口、带宽和内存调整。确认 IPv6 启用情况并补齐对应 peer 地址限制，防止 IPv4 限制之外的管理网访问。[coturn 官方配置参考](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

TLS 后续模板差异：移除 `no-tls`，增加 `tls-listening-port=5349`、`cert=/受限路径/fullchain.pem`、`pkey=/受限路径/privkey.pem`，后端添加 `turns:turn-rc.example.com:5349?transport=tcp`。如只支持 TLS-over-TCP，可保留 `no-dtls`。证书域名必须匹配、服务账户能读、续期后重新加载，并用实际客户端验证；3480 明文 TURN 控制连接与加密 WebRTC 媒体是不同层，不混淆两者。

### 5.2 凭据与签名轮换

TURN REST 共享 secret 只存后端/中继。短期用户名/密码由已授权会话接口签发，密钥不进前端构建。当前用户名 HMAC 规则和有效期沿用既有 `remoteIce.ts`，不能在服务器配置里另造不兼容方案。

Ed25519 轮换顺序：生成新 keyId → 发布同时信任新旧公钥的客户端 → 检查覆盖率 → 服务端切换新签名 → 等旧会话及旧密钥窗口结束再移除旧信任。当前签名器为单活动密钥，双签名/按客户端选签名若需要则先实现；不能在客户端未更新前直接切换导致全部拒绝连接。发现泄露时立即关准入/停止相关会话，并通过紧急发布撤销旧信任。

TURN secret 的平滑重叠接受能力取决于实际 coturn 配置方式；先测试多 secret 或新节点切流，不能假设单 `static-auth-secret` 文件更改不影响现有用户。静态账号兼容期结束后应轮换/撤销旧账号，清理长期泄露风险。

## 6. 反向代理与基础服务配置

沿用现有 Caddyfile 和 Nginx 路由，无需重写成另一个拓扑。部署检查：

- `/api/health/ready` 通过后端实际校验；静态首页 200 不代表数据库或远控服务可用。
- `/meeting`、`/connect` 的 upgrade/header 和长连接 timeout 保留；新增远控事件复用实际 Socket path，不能误配默认路径。
- 两层代理传递可信来源的协议/地址，后端仅信任受控代理。当前 Nginx `$scheme` 表示代理内部 HTTP，后续需要生成绝对 HTTPS 地址或安全 cookie 时，应先修正/验证可信转发头，不能接受任意客户端伪造 X-Forwarded-*。
- 当前 `client_max_body_size 12m` 是聊天上传相关限制；设备大文件应走 DataChannel 或有边界的对象存储分片上传，不把 Nginx/Koa body limit 改成无限。
- CDN 只缓存静态版本资源；鉴权、ICE、权限与私有下载授权响应不缓存。对象下载用短时签名，权限过期后不可继续获取新 URL。
- 生产 DB 不公网监听；增加应用连接池、慢查询统计和备份，但连接数必须按实例数计算，不能每个新实例都开大池。
- Redis 当前 AOF+口令为起点。远控状态不能被无差别 cache 淘汰；规划独立实例或 `noeviction` 并监控 OOM。使用 Redis Cluster 前审查 Lua 多键操作/hash tag，以及从 DB=1 迁移到 Cluster DB0，不能只改地址。

## 7. 后续功能配置登记表（尚未实现）

以下名称只是设计建议，当前代码不会因为添加这些环境变量而启用功能。开发时必须加入配置 schema、example、启动校验、权限与文档；按设备/组织的动态政策应存在 DB，避免全部塞进 env。

| 建议参数/配置对象 | 建议初始值 | 用途/归属 |
| --- | --- | --- |
| REMOTE_MAX_SESSIONS_PER_USER | 2（实验） | 服务端并发上限，须配原子配额服务 |
| REMOTE_MAX_VIEWERS_PER_HOST | 3（实验） | 多人观看限制，不自动开启并发输入 |
| REMOTE_FILE_MAX_BYTES | 10737418240（10GiB） | 单任务策略起点；平台、账户可收紧，>4GiB 必测 |
| REMOTE_CLIPBOARD_MAX_BYTES | 1048576 | 文本限制，图片单独参数 |
| REMOTE_TEMP_OBJECT_TTL_HOURS | 24 | 云端临时文件自动删除；可取消任务立即清理 |
| MFA_ENCRYPTION_KEY / MFA_KEY_ID | 受限 secret / keyId | TOTP 因子加密与轮换，非 JWT secret |
| REMOTE_AUDIT_RETENTION_DAYS | 180 | 新业务审计保留期，不能默默替换旧生命周期规则 |
| REMOTE_NODE_CATALOG | 受控配置资源引用 | 节点 URL/区域/容量，密钥引用单独管理 |
| REMOTE_INSTANCE_ID | 每实例唯一值 | 分布式所有权；配置本身不能解决 split-brain |
| OTEL_EXPORTER_OTLP_ENDPOINT | 私网 collector | 完成埋点后启用，不采集输入/画面正文 |
| 更新渠道配置 | preview、分桶比例、最低安全版本 | 更新服务/签名清单，签名私钥保存在构建侧 |
| 组织策略 | 按组织/设备 scope、访问名单、到期、MFA | DB 版本化管理；不作为前端静态配置 |

## 8. 监控、日志与告警

当前已有分钟级 `realtime_metrics` 日志；Prometheus/OTel 等指标服务属于 W16 新建。指标标签保持低基数，sessionId/userId 放脱敏关联日志，不能作为指标 label 导致存储爆炸。

| 信号 | 指标/测量 | 首轮告警与动作 |
| --- | --- | --- |
| API | readiness、5xx、p95、event-loop lag | 连续不可用 1 分钟通知；关闭新建远控，保留诊断 |
| 会话 | 建连成功率、p95 时延、终止 reason、活跃数 | 5 分钟失败率 >5% 且样本 ≥20 先排查；基线稳定后调整 |
| 授权 | 租约签发失败、过期、撤销传播耗时 | 任何越权/撤销后继续输入事件阻断发布并停相关能力 |
| 媒体 | 实际 FPS、码率、RTT、丢包、freeze | p95 持续劣化触发降档；不能关闭失活保护 |
| TURN | allocation、端口、带宽、认证失败、丢包 | 70% 预算预警，拒绝无授权负载并提前导流 |
| 数据 | MySQL 池/慢查询/磁盘，Redis 内存/eviction/延迟 | 任何会话状态 eviction 为异常；磁盘 80% 预警 |
| 后台任务 | outbox lag、未落终态、临时对象清理 | 对账积压超过约定窗口报警，修复后重放幂等事件 |
| 发布 | 客户端 crash、引擎退出、权限失败、更新失败 | 版本与平台维度观察，灰度异常停止放量 |
| 安全维护 | TLS/签名密钥有效期、备份恢复记录 | 到期前 30/14/7 天提醒，轮换有负责人 |

诊断包只含应用/OS/引擎版本、能力状态、错误码、网络类型、脱敏 trace 和统计；日志排除 JWT、TURN 密码、私钥、完整 SDP、剪贴板及输入正文。导出前可预览/选择范围；支持包有过期时间与受限访问。

初始建议 SLO：内测控制面月可用性 99.5%，正式企业服务目标待架构与值班能力就绪后再设；建连成功率先按环境和客户端版本分组，不排除失败样本来美化指标。可用性目标不代表当前已达成。

## 9. 备份、恢复与故障处理

- MySQL：每日加密全备+binlog/PITR，异机或对象存储保留；建议目标 RPO ≤15 分钟、RTO ≤2 小时，必须恢复演练证明。
- Redis：保留必要持久化和配置备份，但恢复后所有旧远控租约/活跃授权按失效处理，重建连接需重新授权；缓存不能恢复已撤销设备。
- 密钥：JWT、刷新令牌、Ed25519、TURN、MFA、更新签名分别备份并控制访问。恢复数据时核对撤销版本和秘密版本，不得让旧快照恢复被撤销凭证。
- 七牛：公共/私有空间生命周期独立；任务临时对象 24 小时删除是新策略提案，实施时确认下载/续传规则。审计及可选录像按组织保留期处理。
- 每月在隔离环境恢复一次数据库和配置，确认登录、设备撤销、旧 token 拒绝、文件授权以及会话历史。只验证备份文件存在不足以达标。

故障顺序：停止新建 → 有序停止/让租约到期 → 保留受限诊断 → 回滚配置或镜像 → 验证授权和传输 → 小流量恢复。Redis/MySQL 不可用时不发无限凭据，设备已在本地授予的短租约按既有上限结束。

## 10. 部署和回滚清单

### 10.1 上线前

1. 确定变更范围、目标 alpha 版本和协议兼容矩阵；功能开发批次同步所有自有版本。
2. 本地/CI 测试、真机验收、签名/公证和镜像扫描完成；产物用固定提交 SHA/tag 和 digest，避免生产依赖 latest。
3. 核对 env 必填项、目标 DB、端口、DNS、TLS、时间同步、密钥窗口、桌面可信公钥。远控入口保持关闭或原有预览范围。
4. 核对上一版可回滚镜像、受限配置备份和数据库恢复点；安排维护窗口。当前迁移流程会停后端写入，不能宣称零停机升级。

### 10.2 服务器执行参考

这些命令在已按原部署手册准备好的服务器目录执行；本次未执行。将变量值替换为已验证产物的真实 SHA，先拉取再停服务迁移：

```sh
cd /opt/todesk
export IMAGE_TAG='REPLACE_WITH_VERIFIED_COMMIT_SHA'
docker compose --env-file .env.production -f docker-compose.prod.yml pull
bash deploy/migrate-database.sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --pull never
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T backend pnpm db:migrate --check
```

迁移脚本当前负责停写、备份、使用目标镜像迁移；备份或迁移失败保持停服并排查，不手动绕过失败开新后端。新增表需先在迁移执行器登记并跑重复执行/中途失败测试。MySQL DDL 不能假定整批事务回滚。

部署后检查公网 readiness、登录/刷新/撤销、Socket 重连、文件授权、真实产品远控；分别确认 release capability 与实际引擎能力，不只检查容器 running。发布时先指定测试账号，再按平台与版本扩大；比例灰度需先实现相应配置服务。

### 10.3 回滚

优先关闭受影响能力/停止准入，再终止相关会话。恢复上一份环境配置和已验证的镜像 SHA，保留向后兼容的新字段/审计，不先 DROP TABLE。若新 schema 与旧镜像不兼容，仅回滚到已验证兼容版本或执行隔离恢复程序，不能混跑旧鉴权逻辑。

密钥轮换回滚和功能回滚分开：已泄露/撤销密钥不得为恢复可用性而重新信任。数据库备份恢复属于有数据丢失风险的灾备操作，按 RPO 评估并停止所有写入，不作为每次普通发布的默认回退。

### 10.4 开放记录模板

```text
功能 ID / 工作包：
提交 SHA / 产品 alpha 版本 / 镜像 digest：
主控系统、浏览器或客户端版本：
被控系统、架构、安装包、引擎版本：
系统权限、签名和授权方式：
网络条件 / 实际选中直连或中继 / 区域：
成功操作证据 / 延迟与帧率 / 持续时长：
拒绝、撤销、断线、停止及资源释放结果：
测试负责人 / 日期 / 缺陷与限制：
服务端发布范围 / 回滚版本：
```

## 11. 立项后需落实的资源信息

本方案以单区域、约 20 活跃会话内测为首轮压测假设。采购/正式排期前补齐：预期并发与日在线时长、中继比例、用户地域、带宽预算、Windows/Mac/Linux/手机目标版本、是否必须无人值守、已有服务器和公网端口权限、签名证书、七牛空间策略及测试人员。缺失这些信息不影响先执行 S0 收口，但会影响资源费用与 S3/S4 交付日期。
