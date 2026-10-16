# 本地启动指南

项目由 Vue / Vite 前端、Koa 后端、MySQL 和 Redis 组成。日常开发优先连接本机已有的 MySQL 和 Redis，以免误连到空的容器数据库。

## 安装依赖

需要 Node.js 22 和 pnpm 10.14.0。在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
```

## 启动本地 MySQL 和 Redis

先检查服务及端口；当前后端默认连接 MySQL `127.0.0.1:3306`、Redis `127.0.0.1:6379`：

```bash
lsof -nP -iTCP:3306 -sTCP:LISTEN
lsof -nP -iTCP:6379 -sTCP:LISTEN
```

如果使用 Homebrew 安装，可按安装时的服务名启动：

```bash
brew services start mysql
brew services start redis
```

如果使用 `/usr/local/mysql` 安装的 MySQL，可用安装包自带脚本启动：

```bash
sudo /usr/local/mysql/support-files/mysql.server start
```

确认连接到存放原数据的实例，别仅凭端口判断。用交互式密码登录，并检查数据库：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p
```

```sql
SHOW DATABASES;
USE todesk;
SELECT COUNT(*) FROM users;
```

Redis 检查：

```bash
redis-cli -h 127.0.0.1 -p 6379 ping
```

应返回 `PONG`。如果本机安装方式不同，请使用该安装方式提供的启动命令。不要初始化或覆盖已有 MySQL 数据目录。

## 启动后端

首次启动先从示例创建个人配置文件：

```bash
cp backend-koa/.env.example backend-koa/.env.local
```

根据本机 MySQL、Redis、七牛开发空间和邮箱配置编辑 `backend-koa/.env.local`，然后从仓库根目录执行：

```bash
pnpm env:check
pnpm run server
```

后端启动脚本会加载并校验 `.env.local`。连接旧库时不要随意启用 `DB_AUTO_CREATE` 和 `DB_SYNC_ALTER`。七牛 AK/SK 与 CDN 域名是文件上传必填项；空间名和签名有效期由项目配置固定。SMTP 变量只在调试邮箱验证码时填写，但必须整组填写。密钥和授权码只保存在本机，文件权限建议为 `600`。

后端默认监听 `http://localhost:3000`。

## 启动前端

前端默认监听所有网卡并启用 HTTPS。首次启动先按[局域网 HTTPS 配置步骤](./docs/ENVIRONMENT_VARIABLES.md#局域网-https-开发)生成证书，并创建个人配置（已有文件直接编辑）：

```bash
cp client-vue/.env.example client-vue/.env.local
```

在配置中填写 `DEV_HTTPS_CERT` 和 `DEV_HTTPS_KEY`；本机后端的 `VITE_API_BASE_URL` 和 `VITE_SOCKET_URL` 留空，使用同源代理。再打开一个终端，在仓库根目录运行：

```bash
pnpm run client
```

浏览器打开 `https://localhost:5173/`；其他电脑使用证书覆盖的主机名或局域网 IP，并信任对应 CA。端口以启动日志为准。Vite 将 `/api`、`/meeting` 和迁移期兼容的 `/uploads` 代理到后端的 3000 端口。新文件由后端直接上传七牛，浏览器不需要七牛变量。修改后端端口时，还需修改 `client-vue/vite.config.ts` 的代理目标。`VITE_*` 会进入浏览器代码，不能填写任何密钥。

仅需本机 HTTP 调试时，可显式运行 `pnpm --filter client-vue dev:http`。桌面端仍使用独立的 Tauri 开发命令。

## 检查与停止

```bash
curl -I https://localhost:5173/
curl -i http://localhost:3000/api/auth/me
```

前端应返回 200；未登录时 `/api/auth/me` 返回 401 是正常的。前后端在各自终端按 `Ctrl+C` 停止。本地 MySQL 和 Redis 由各自的服务管理器停止。

如果登录后看不到原有用户数据，请先核对 `DB_HOST`、`DB_PORT`、`DB_NAME`，再核对 MySQL 数据目录和登录账号；切换到 Docker 的新数据库通常会看到空表。完整规则见 [环境变量管理规范](./docs/ENVIRONMENT_VARIABLES.md)，生产部署另见 [DEPLOYMENT.md](./DEPLOYMENT.md)。
