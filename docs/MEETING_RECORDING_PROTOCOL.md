# 会议录音实时转写协议（Socket.IO path `/meeting-minutes`）

> `/meeting-minutes` 是 Socket.IO 服务器的 **path**（HTTP 升级路径），不是 namespace。
> 本文件是前后端与 ASR 之间的唯一协议来源；实现以本文件为准。

## 总体流程

```text
用户点击开始
→ 前端准备麦克风（AudioWorklet 已加载，但尚未输出分片）
→ 建立经 auth 握手的 Socket.IO 连接（WebSocket transport）
→ emit 'minutes_start'（不携带 sessionId）
→ 服务端：校验 ASR 可用 → 创建 sessionId（服务端 UUID）→ 写库 create → 打开 ASR
→ ACK 返回 sessionId、audioFormat、capabilities
→ 前端保存 sessionId，开始输出音频分片
```

身份只来自握手认证（`auth.token`），业务消息中不携带 `userId`。

## 握手认证

客户端：

```ts
io(origin, {
  path: '/meeting-minutes',
  transports: ['websocket'],
  reconnection: false, // 重连由 Manager 显式发起
  auth: { token },
})
```

- 服务端在 `io.use` 中间件中调用 `validateAuthenticatedSession(token)`；
- 校验失败时以 `Error` 拒绝连接（`CONNECT_ERROR`），客户端连接 Promise 必须失败；
- token 过期（`token_expired`）时客户端复用现有 token 刷新能力后重连；
- 其他认证失败（会话撤销、退出登录）为终止条件，不重连。

## 控制请求（emit + ACK callback）

| 事件 | 请求 payload | ACK |
|---|---|---|
| `minutes_start` | `{ source?: 'offline'|'call', callId?: string }`（不允许携带 sessionId；通话来源必须带 callId） | `{ ok, sessionId, audioFormat: { encoding:'pcm_s16le', sampleRate:16000, channels:1 }, capabilities: { transcription:boolean } }` 或 `{ ok:false, error }` |
| `minutes_attach` | `{ sessionId }` | `{ ok, status, lastAcceptedAudioIndex, acceptedSamples, pausedAttachDeadline }` 或 `{ ok:false, error, recoverable? }` |
| `minutes_pause` | `{ sessionId }` | `{ ok, lastAcceptedAudioIndex, pausedAttachDeadline }` |
| `minutes_resume` | `{ sessionId }` | `{ ok, lastAcceptedAudioIndex, pausedAttachDeadline }` |
| `minutes_end` | `{ sessionId, lastAudioIndex, tailComplete }` | `{ ok, durationSeconds, transcriptComplete, audioStatus }` 或 `{ ok:false, error }` |

start 前置校验：

- 用户已有活动（recording/paused/finalizing）会话 → `SESSION_ACTIVE`；
- ASR 未配置或连接/初始化失败：仍创建录音并保存音频，ACK 的 `transcriptionAvailable=false`，界面提示转写不完整；不把转写故障当作音频故障。

start ACK 丢失或服务端清理时：会话进入有界宽限，未绑定连接的会话在 `attachDeadlineMs`
后被收尾（保存已识别内容，`endReason='disconnect_timeout'`）。

## 音频分片（二进制）

```ts
// 前端
socket.emit(
  'minutes_audio',
  { sessionId, audioIndex },              // 元数据（JSON）
  pcmArrayBuffer,                          // 二进制载荷（Socket.IO 原生二进制）
  (ack) => { /* { sessionId, lastAcceptedAudioIndex } */ },
);
```

约定：

- 固定格式 16kHz 单声道 PCM16LE，200ms/片，约 6400 字节；格式在 start 时确定，不逐片上报；
- `audioIndex` 从 0 开始整场连续递增，是顺序与去重依据；
- 服务端按 `字节数 / 2` 计算样本数，不信任客户端时长；
- 服务端校验：二进制类型、长度上限（128KiB）、偶数字节、会话归属、会话状态、序号；
- ACK 的 `lastAcceptedAudioIndex` 为累计确认值：
  - 新片被接受：= 该片 audioIndex；
  - 重复片（audioIndex <= 已确认）：返回当前确认值，不重复送 ASR、不重复累计；
  - 序号跳跃：返回当前确认值（客户端据此等待/补发，服务端不静默跳过）；
- **ACK 语义：表示该分片已持久化到服务端暂存（manifest 落盘）。**
  服务端先把分片写入暂存目录并持久化进度，再返回 ACK；写入失败时 ACK 报错，
  客户端保留该分片。客户端只删除已持久化确认的分片。
- ASR 故障不阻止音频保存：ASR 不可用时音频分片仍被持久化（转写标记不完整），
  音频状态与转写状态相互独立。

## 服务端推送

| 事件 | payload |
|---|---|
| `minutes_transcript` | `{ sessionId, segments: TranscriptSegment[] }` |
| `minutes_error` | `{ sessionId, error, message? }`（可恢复的会话级错误，如 ASR 故障暂停） |

`TranscriptSegment`（前后端统一结构，ASR 适配层负责转换）：

```ts
interface TranscriptSegment {
  segmentId: number;        // 会话内递增；同一句的临时/最终结果共享同一 id
  text: string;             // 当前句的累计文本（临时结果替换，最终结果落定）
  isFinal: boolean;
  startMs: number;
  endMs: number | null;
  speakerId: string | null; // 仅表达说话人，不用于判断是否确认
}
```

- 同一 `segmentId` 的临时结果替换当前临时句；最终结果覆盖该句并落定；
- 服务端只持久化确认句（最终结果），按序串行写检查点，失败不静默丢弃。

## 断线恢复

- 网络断开时前端暂停采集、保留未确认队列；
- 服务端解绑连接，保留会话、ASR 与已持久化音频，启动有界恢复期限；
- **暂停与断线分开计时**：手动暂停的草稿保留 **3 小时**；普通录制断线恢复期 **5 分钟**。
  截止时间由服务端持久化（数据库 `audioPausedAttachDeadline`），进程重启后仍有效；
- 重连（新连接，握手认证后）emit `minutes_attach` 携带服务端发放的 sessionId；
- attach 校验归属与可恢复性；原手动暂停的会话恢复连接后仍保持暂停；
  超过恢复期限的会话已收尾（`endReason='pause_expired'`），attach 返回 `SESSION_NOT_FOUND`；
- 同一录音仅允许一个活动上传连接。

## 音频持久化与保存

- 最终音频统一为 **16kHz 单声道 16-bit PCM WAV**，上传**七牛私有空间**；
  数据库只存稳定的对象引用（`qiniu://private/<key>`，复用 `storageRef` 约定），不存短期签名 URL；
- 暂存目录（`MEETINGS_AUDIO_STAGING_DIR`）必须持久化且不可公开访问，仅用于录制暂存、
  异常恢复和上传重试；
- 正常结束与异常收尾走同一条链路：

  ```text
  停止采集并接收尾片
  → 等待分片持久化
  → 流式封装 WAV（不把整场音频读入内存）
  → 上传七牛私有空间（固定对象 key，重试不产生新对象）
  → 更新数据库音频状态和对象引用
  → 清理本地暂存
  ```

- 七牛上传或数据库更新失败时保留本地文件，`audioStatus='failed'`，支持幂等重试；
  上传成功但数据库更新失败的重试不会重复创建对象；
- 音频状态（`audioStatus`）与录音状态（`status`）、转写完整性相互独立：
  `recording / pending / uploading / ready / partial / failed / missing / deleting`。

## 进程重启恢复

- 启动时扫描 `recording / paused / finalizing` 的记录：
  - 暂停中且 3 小时保留期未过：保留草稿，用户重新打开页面并明确继续后仍可恢复（不自动打开麦克风）；
  - 其余（录制中断、finalizing 中断、保留期已过）：封装已有分片并上传七牛，
    尾片完整性无法确认时标记 `partial`，处理或保存失败时标记 `failed`；
  - 录音状态统一标记 `failed`（`endReason='process_restart'`），保留已有转写；
- ASR 故障不阻止音频保存：重启续传只处理音频，不依赖 ASR。

## 结束屏障

```text
暂停 Worklet（等待尾片输出完成通知；失败则标记尾片不完整）
→ 发送全部剩余音频并等待最后一片 ACK
→ emit 'minutes_end' { sessionId, lastAudioIndex: 最后实际产出序号 }
→ 服务端进入 finalizing：冻结输入（不再接收新音频），继续接收 ASR 最终结果
→ ASR finish 等待结束结果（超时保存已有内容，transcriptComplete=false）
→ 封装 WAV → 上传七牛 → 更新数据库（音频状态 + 转写状态独立）
→ 返回结果（含 audioStatus：ready/partial/failed，前端据此区分保存结果）
→ 清理本地暂存
```

- `lastAudioIndex` 为**最后实际产出的序号**（非仅已确认序号）；服务端不能仅因收到 end
  就认定音频完整——仅当已持久化连续分片覆盖到该序号且无缺口时且 `tailComplete=true` 时音频才标 `ready`；缺片先拒绝结束（`AUDIO_GAP`）让客户端补发，无法证明尾片完整时标 `partial`；
- 尾片 Worklet 确认失败时客户端标记尾片不完整，服务端标 `partial`；
- 重复 `minutes_end` 复用同一收尾 Promise，返回已有结果（不重新生成会话或对象）；
- end ACK 丢失后再次 end 读回已保存结果；
- 收尾超时/失败时 `transcriptComplete=false`，前端明确提示转写不完整；
- 音频保存失败（`audioStatus='failed'`）不能提示"录音已成功保存"，转写已保存可单独说明。

## 录音时长

```text
录音时长(秒) = 去重后累计 PCM 样本数 / 16000
```

暂停、断线等待与 ASR 收尾时间不计入。


## 浏览器恢复与通话归属

- 未收到持久化 ACK 的分片先写入按账户隔离的 IndexedDB，再发送；ACK 后清理对应分片。内存背压仍限制未确认队列约 30 秒。
- 录音页通过 `GET /api/meetings/active` 提示恢复或结束。恢复先 attach 获取连续确认点，补发本地后续分片，保持暂停；用户点击继续才准备输入。
- 用户确认放弃时调用 `POST /api/meetings/:sessionId/discard`。服务端关闭该草稿的恢复和收尾入口，将其从列表移除，并由已有清理任务处理音频和记录。客户端收到成功响应后才删除本地草稿；重复提交已放弃的会话仍返回成功。
- 不依赖 beforeunload 发送尾片。关闭浏览器、进程终止或未确认的 Worklet 缓冲都可能造成尾部缺失，异常收尾标 partial；服务器只保证已经持久化的音频。
- 手动暂停保留 3 小时，普通断线保留 5 分钟；恢复资格到期后收尾已有音频，不重新打开已结束会话。客户端本地缓存不能使已经结束的服务端会话重新可写。
- 客户端确认结束后，服务端保存音频并将重转写任务写入数据库。后台按顺序重放完整可用的 WAV，用新识别的分段替换实时转写，再生成 AI 纪要并补齐空标题。已有标题保留。进程重启继续处理未完成的阶段。重转写失败时保留实时转写，可在会议详情重试；暂无识别文本时不生成纪要。
- 转写模块的 `POST /api/meetings/:sessionId/transcript` 将已保存录音重新送入转写和纪要队列。清理本地暂存后的录音使用七牛私有对象的签名地址流式读取。`POST /api/meetings/:sessionId/summary` 将现有转写送入纪要队列并返回 `202`。每次生成结束后可再次提交，失败时保留上一版可用结果。
- `/meeting` 的 `meeting_updated` 在状态落库后发给会议归属用户的已认证连接，包含一行列表快照及详情变更标记。删除事件的快照为空。前端按会话更新列表，按需查询当前详情，重连认证后补查当前页和详情。
- `GET /api/meetings?sessionId=…` 按现有列表排序定位录音所在页。`POST /api/meetings/batch-delete` 接收 `sessionIds`，每批最多 50 条。归属及可删除状态整批校验通过后标记删除，七牛和本地文件沿用后台清理任务。
- 通话纪要混合现有本地和远端通话音轨，动态同步新增或替换音轨；不另开麦克风，不停止通话拥有的音轨。通话全员静音属于正常行为，不触发设备全零暂停。
- 独立录音才展示全局录音浮窗。通话开关与挂断按 callId 校验归属，不能结束其他入口的录音。混音保留匿名发言人标签，不推测真实成员。

## 上传及清理补偿

- manifest 之外单独保存 identity.json，保留原七牛对象 key 和登录会话归属。元数据损坏不得虚增确认序号或生成新 key；无法恢复身份时保留文件并报错。
- 上传结果写回 manifest 后再更新数据库，重复收尾复用固定 key。音频失败自动重试最多 3 次，也可在详情点击“重试保存音频”（`POST /api/meetings/:sessionId/audio/retry`）。
- 数据库原子状态约束音频重试、删除与纪要生成；删除先标记 deleting 并从列表隐藏，云端和本地均清理成功才删除记录。删除或本地清理失败保留任务，后台每分钟继续处理；七牛 612 按已删除处理。
- 新增迁移 `20261118-meeting-audio-recovery.up.sql`（audioSize/audioRetryCount/audioRetryAt），与音频字段迁移一起执行。生产暂存目录必须挂载持久化卷。
- 验收待合入 master 前统一执行：真实麦克风/通话双向声音、静音与拔插、刷新与多标签、暂停后关闭、进程中断各阶段、七牛失败重试与删除补偿、私有签名过期和长音频 Range 拖动。
