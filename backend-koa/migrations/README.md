# Login session migration

## 部署与故障恢复

2026-09-27 线上恢复记录：生产后端为 `9a8079e` / `0.4.0-beta.2`，ORM 已创建会话与远控表，但已有 `users` 表缺少 `authVersion`。停止后端并完整备份应用数据库后，补充该列、为 6 个账号回填 UUID 并约束为 NOT NULL；同一数据库连接中的前后快照确认用户名和密码变更数为 0。备份位于服务器 `/opt/todesk/backups/auth-version-20260927-1505/database.sql`，权限 600，旁有 SHA-256 校验文件。重启后，公网登录接口恢复正常校验，现有桌面客户端真实登录成功且生成有效会话。此为线上缺失字段修复；下述通用迁移命令和部署防护仍需随后续代码发布，不代表它们已经部署。

新版认证上线前必须执行迁移。`sequelize.sync({ alter: false })` 只会创建缺失表，不会为已有 `users` 表补充 `authVersion`；遗漏迁移会导致所有登录报 `Unknown column 'authVersion' in 'field list'`。

当前部署流水线先停止后端写入，将应用数据库备份到服务器 `/opt/todesk/backups/schema-*`，再用即将部署的镜像运行 `pnpm db:migrate`。备份或迁移失败立即中止部署并保留后端停止状态，不能跳过错误继续发布。备份含账号等敏感数据，目录和文件只允许服务器管理员访问，不上传到 CI 日志或仓库。

迁移命令按本文三个 SQL 文件执行增量操作，使用同一 MySQL 连接的命名锁防止同时迁移；识别已存在的字段、表和等价索引，可重试已完成或中断的迁移，仅回填缺失认证版本，保留有效版本、会话和历史记录。它不会修复任意未知结构：遇到非预期缺失字段会失败并要求人工检查。DDL 不具备整批事务回滚能力，必须先备份、停止所有应用写入实例。禁止混跑旧认证版本。

手动维护时，在已加载目标镜像的服务器目录中执行：

```sh
cd /opt/todesk
export IMAGE_TAG=<目标提交 SHA>
bash deploy/migrate-database.sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --pull never
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T backend pnpm db:migrate --check
```

后端启动会校验认证、远控字段和幂等唯一索引；缺失时不监听端口。部署检查 `/api/health/ready`，不再仅以静态首页返回成功判断后端可用。客户端无需重新安装；旧版无 sid 的登录凭据仍须重新登录。

`20260925-login-sessions.up.sql` is an explicit MySQL 8 migration. It has not been applied to production. Announce a one-time sign-in requirement, stop writers, take a backup, apply the migration, and deploy the server and client together. Existing access/refresh JWTs without `sid` and nonempty `authVersion` will receive 401; public API field names are retained. Do not run multiple application versions during this change. `sequelize.sync({ alter: true })` is not the migration procedure.

Each login has a separate row. Refresh compares account version, session revocation, and refresh SHA-256 under the same user-then-session locks; a version/hash CAS commits the replacement. Password replacement and all-session revocation share a transaction. Redis is not an authentication source.

`/api/auth/logout` has a dedicated revocation-only verifier. A correctly signed expired access token can revoke its own still-current sid after the same durable account/session checks. It cannot authenticate any other REST or Socket operation, renew credentials, or select a different sid. The client sends the captured logout token without refreshing it, so a concurrent new login cannot be accidentally logged out.

Clients can supply a 16–128 character `requestId` (UUID recommended) to `/api/auth/refresh-token`; retry the same failed HTTP request with the same ID and old refresh token. For 10 seconds the server can recover the same AES-256-GCM encrypted response, after checking durable revocation. New refresh attempts must use a fresh ID. Omission remains supported but cannot recover a lost response. Ciphertext is bound to sid and the configured refresh signing secret; signing-secret rotation intentionally invalidates it. Expired response columns can be cleared with the maintenance query below; never delete active/revoked session rows to “restore” them.

```sql
UPDATE login_sessions SET rotationRequestId = NULL, rotationInputHash = NULL,
  rotationResponse = NULL, rotationExpiresAt = NULL
WHERE rotationExpiresAt <= NOW();
```

`20260925-login-sessions.rollback.sql` invalidates sessions but preserves columns/history. Roll back only to a release that still rejects missing versions/sids. A destructive schema rollback or the old null-version implementation would resurrect credentials and is unsupported.

The MySQL integration test requires `AUTH_TEST_MYSQL_URL` pointing to a disposable database with a name beginning `todesk_auth_test_`. It never reads `.env.local`, and drops only the authentication and remote-control test tables it creates. Run from `backend-koa`: `AUTH_TEST_MYSQL_URL=... pnpm exec vitest run --config vitest.integration.config.ts`.

## Remote-control schema

Apply `20260925-remote-control.up.sql` after the login-session migration and before starting this server version. It adds device public keys, temporary discovery grants, and session history with ownership indexes. Registration proves possession of a device key; it does not grant online host status or permission to control a computer. The remote-control release gates remain closed after both migrations.

`20260925-remote-control.rollback.sql` preserves device, revocation, and history records. Disabling the feature must not drop those records or reactivate old device credentials. The integration tests cover applying the remote schema twice, ORM read/write compatibility, fingerprint uniqueness, and preservation by rollback. Neither migration has been applied to the existing application database during development.

## Lifecycle and audit migration

Apply `20260926-remote-lifecycle.up.sql` once after the two migrations above and before starting the lifecycle worker. It adds durable request idempotency, reconciliation indexes, and `remote_session_events`. The rollback script retains these fields and audit events. No release gate is opened by this migration.

The runtime starts with admission paused and terminates sessions left by a previous server process. It then scans deadlines, revocation jobs, terminal outbox entries, and incomplete history in bounded batches (25 by default). It is designed for one active backend instance; running multiple admission/runtime instances requires a separate ownership and routing design before release. SIGTERM/SIGINT pause admission, unsubscribe revocation listeners, stop the interval, end live sessions in Redis, and attempt a bounded history flush before closing connections. The application enforces a 10-second shutdown deadline.

A request must commit its SQL identity and initial event before Redis admission. SQL failure therefore cannot create endpoint occupancy. End/cancel/timeout/revocation transitions commit an atomic Redis terminal event and release only locks still owned by that session; SQL archival is asynchronous and retryable. An outbox acknowledgement compares its exact prior value, and `(sessionId,eventSeq)` prevents duplicate audit rows. Known admission rejections are recorded; ambiguous Redis transport failures are reconciled without claiming a successful admission or an exact end time.

Reconciliation has a 60-second grace period, longer than the 45-second admission deadline. Missing Redis state becomes `interrupted` with `endedAt = NULL`; its audit event has only an observed time. Redis errors are not treated as absence. Historical rows never restore live authorization. Account revocation jobs identify the *revoked* version, so a late v1 revocation event cannot revoke a later v3 login.

History visibility and retention share a 30-day constant. Cleanup deletes only `ended`/`interrupted` rows whose `updatedAt` is older than that window, together with their audit events in one SQL transaction. A Redis check protects every unacknowledged outbox entry (including deferred retries) and live session; Redis errors roll cleanup back. Each tick scans at most one bounded batch with a cursor so protected rows cannot starve later rows. Once a sweep drains, cleanup waits one hour before scanning again. This relies on terminal session immutability and non-reused random session IDs; historical data never creates new runtime sessions.

The new lifecycle integration suite runs real SQL triggers/transactions against the disposable test database and starts its own Redis Unix socket. It covers history-write rejection, concurrent request idempotency, bounded expiration, stale deadline cleanup, failed archival/retry, exact outbox acknowledgement, grant-creator logout, out-of-order account revocation, Redis loss, restart, shutdown, and retention transaction rollback/outbox protection. Existing application databases have not been migrated by these tests.

### 20260927 协助许可时长

`20260927-assistance-duration.up.sql` 将许可 `expiresAt` 改为可空，NULL 表示长期请求许可；既有日期保持不变。更新后端前先备份并执行 `pnpm db:migrate`，再运行 `pnpm db:migrate --check`。退出创建许可的登录会话、撤销设备或手动撤销许可仍会使其失效。媒体授权与每次本机确认不由该字段替代。回滚旧后端前需先处理长期许可，不能直接恢复 NOT NULL。
