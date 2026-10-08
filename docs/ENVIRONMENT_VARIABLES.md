# 环境变量管理规范

本文规定 NearLink 在本地开发、测试、容器运行和生产部署中的环境变量管理方式。任何新增变量都必须先确定归属，再进入对应的配置入口，业务代码不得自行读取原始环境变量。

## 配置文件与职责

| 场景                | 示例文件                         | 真实配置文件                               | 加载方                    | 是否可提交               |
| ------------------- | -------------------------------- | ------------------------------------------ | ------------------------- | ------------------------ |
| 本地 Docker Compose | `.env.example`                   | `.env`                                     | Docker Compose            | 示例可提交，真实文件禁止 |
| 后端本地开发        | `backend-koa/.env.example`       | `backend-koa/.env.local`                   | Node `--env-file`         | 示例可提交，真实文件禁止 |
| 前端本地开发        | `client-vue/.env.example`        | `client-vue/.env.local`                    | Vite                      | 示例可提交，真实文件禁止 |
| 生产应用            | `.env.production.example`        | `/opt/todesk/.env.production`              | Docker Compose / 后端容器 | 示例可提交，真实文件禁止 |
| 共享基础设施        | `.env.infrastructure.example`    | `/opt/shared-services/.env.infrastructure` | Docker Compose            | 示例可提交，真实文件禁止 |
| 后端单元测试        | `backend-koa/tests/setup-env.ts` | 无                                         | Vitest                    | 可提交，仅允许测试值     |

真实配置文件只保存在开发者本机、CI 密钥库或服务器中。团队共享的是示例、申请路径和变量规则，不共享生产密钥明文。

## 后端使用规则

后端只有 `backend-koa/src/config/env.ts` 可以读取 `process.env`。该模块负责：

1. 校验必填项和取值范围；
2. 把端口、布尔值等字符串转换为正确类型；
3. 拒绝示例密钥、重复 JWT 密钥和不完整 SMTP 配置；
4. 对生产环境启用更严格的 Redis、SMTP 和数据库变更约束；
5. 输出按 `app`、`database`、`redis`、`auth`、`qiniu`、`smtp` 分组的只读配置。

业务模块只能导入 `env`，禁止新增 `process.env.X`。这样变量缺失会在进程启动阶段集中失败，而不是运行到某个接口后才暴露问题。

七牛 AK/SK 属于后端私密配置；两个 CDN 域名属于部署配置，必须写在后端 `.env.local`、根目录 Docker `.env` 或服务器 `.env.production`，不能出现在 `client-vue/.env*`。公共空间 `to-desk-pub`、私有空间 `to-desk` 和 3600 秒签名有效期是项目固定配置，集中维护在 `backend-koa/src/config/qiniu.ts`，无需配置环境变量。

本地后端启动前执行：

```bash
cp backend-koa/.env.example backend-koa/.env.local
pnpm env:check
pnpm server
```

## 前端使用规则

前端只有 `client-vue/src/config/env.ts` 可以读取 `import.meta.env`。纯校验规则位于 `client-vue/src/config/publicEnv.ts`，由 Vite 启动/构建阶段和浏览器运行时共同复用；业务模块只能使用 `publicEnv`。

只有 `VITE_` 前缀变量会被 Vite 编译进浏览器代码，因此它们全部属于公开配置，禁止存放密码、Token、AccessKey 或 SecretKey。当前两个地址留空时使用浏览器同源地址，本地开发由 Vite 代理转发。

Vite 按模式加载 `.env`、`.env.local`、`.env.[mode]` 和 `.env.[mode].local`。项目只把个人覆盖值放在 `.env.local`；需要所有开发者共享的非敏感默认值时，才新增可提交的模式文件。

## `cross-env` 的使用边界

`cross-env` 只解决 Windows、macOS 和 Linux 在命令行内设置单个临时变量时的语法差异，例如为一次脚本运行设置 `NODE_ENV=test`。它不负责加载文件、类型转换、合法性校验或密钥管理。

本项目已经分别使用 Node `--env-file`、Vite 和 Docker Compose 加载配置，因此不引入 `cross-env`。如果未来确实出现必须在 `package.json` 中内联设置变量的跨平台脚本，再按需添加，不能用它替代统一配置模块。

## 新增或修改变量的流程

1. 判断变量属于后端私密配置、前端公开配置、部署配置还是基础设施配置。
2. 在对应示例文件中添加变量、用途、必填性、来源和安全说明。
3. 后端变量加入 `backend-koa/src/config/env.ts`；前端变量加入 `client-vue/src/config/env.ts` 和 `client-vue/src/env.d.ts`。
4. 业务代码从统一配置对象读取，禁止直接访问原始环境变量。
5. 同步 Docker Compose、GitHub Actions 或服务器配置。
6. 增加类型转换、非法值和缺失值测试。
7. 运行 `pnpm test`、`pnpm typecheck` 以及相关 Compose 配置检查。

## 密钥规则

- 示例文件只允许占位值，不允许任何真实凭据。
- JWT 密钥至少 32 个字符，访问令牌和刷新令牌密钥必须不同。
- 生产密钥由服务器管理员或 CI 密钥库维护，普通开发者无需持有。
- 密钥轮换必须同步更新所有实际使用位置，并重新创建相关容器。
- 日志、报错和测试快照不得输出环境变量原值。
- `.env.local` 仅适合本地开发；生产环境不得依赖开发者机器上的文件。
