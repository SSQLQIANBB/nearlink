# 会议实时语音识别（ASR）服务

会议转写优先使用腾讯云 ASR，也可使用自部署 sherpa-onnx。后端只做转发编排（见
[backend-koa/src/services/asrClient.ts](../backend-koa/src/services/asrClient.ts) 与
[backend-koa/src/services/meetingRecordingService.ts](../backend-koa/src/services/meetingRecordingService.ts)）。
前后端与 ASR 的完整协议见 [MEETING_RECORDING_PROTOCOL.md](./MEETING_RECORDING_PROTOCOL.md)。

## 云端 ASR 和纪要

在后端 `.env.local`（生产为 `.env.production`）配置：

```dotenv
TENCENT_ASR_APP_ID=
TENCENT_ASR_SECRET_ID=
TENCENT_ASR_SECRET_KEY=
TENCENT_ASR_ENGINE=16k_zh
MEETINGS_LLM_BASE_URL=https://api.siliconflow.cn/v1
MEETINGS_LLM_API_KEY=
MEETINGS_LLM_MODEL=XingChenAGI/Xing4.0-29B
```

腾讯云三项凭据须填齐；云端纪要的地址与 Key 须同时填写。双端音频格式保持 16kHz PCM16LE，
后端按实时速度发给[腾讯云实时 ASR](https://cloud.tencent.com/document/api/1093/48982)。
暂停或客户端断线会先收尾上游流，继续时在同一个会议内重新建立识别流。若上游异常中断，
保留已确认文本并标记结果不完整。纪要通过[硅基流动接口](https://docs.siliconflow.cn/docs/api/chat-completions-post)
生成。这种部署不用在服务器启动 sherpa 或 Ollama；凭据仅存于后端。

## 自部署 ASR 组成

| 文件 | 作用 |
| --- | --- |
| [deploy/asr/Dockerfile](../deploy/asr/Dockerfile) | Python 3.10 + 固定版本 sherpa-onnx/websockets 镜像 |
| [deploy/asr/entrypoint.sh](../deploy/asr/entrypoint.sh) | 校验/下载模型必要文件后启动服务 |
| [deploy/asr/sherpa_asr_server.py](../deploy/asr/sherpa_asr_server.py) | sherpa-onnx 流式识别 WebSocket 服务（句子端点切分） |
| [docker-compose.infrastructure.yml](../docker-compose.infrastructure.yml) | `asr` 服务定义（独立 profile，默认不启动） |

## 协议

- 客户端（后端）连 `ws://<host>:<port>`，发**二进制帧**：PCM16LE 单声道 16kHz，小端，按分片追加；
- 服务端回**JSON 文本帧**：
  `{"segmentId": n, "text": "...", "isFinal": false/true, "startMs": ms, "endMs": ms|null, "speakerId": null}`
  同一 `segmentId` 的临时结果 `text` 为当前句**累计文本**；句子端点（静音 540ms 或 30s 上限）后发送 `isFinal: true`；
- 客户端发文本帧 `{"is_speaking": false}` 结束当前连接音频并触发最终句；
- 健康检查帧：`{"health": true}` → `{"status": "ok", "model_loaded": true}`。

## 构建与启动

```bash
# 1. 构建镜像（仓库根目录）
docker build -f deploy/asr/Dockerfile -t nearlink-asr .

# 2. 启动（Compose profile: asr；首次会自动下载模型到 asr-models 卷，需联网）
docker compose -f docker-compose.infrastructure.yml --profile asr up -d asr

# 3. 确认健康（内部端口 10095，宿主默认 127.0.0.1:10095，可用 ASR_HOST_PORT 覆盖）
docker compose -f docker-compose.infrastructure.yml --profile asr ps   # 状态 healthy 后模型已加载
```

### Ollama（AI 纪要，可选）

未配置云端纪要时，也可以使用独立部署的 Ollama 与 Qwen 模型：

```bash
# 任意可访问的 Ollama 服务（本机或独立容器/主机）
ollama pull qwen2.5:7b
# 后端 .env.local
MEETINGS_LLM_URL=http://<ollama-host>:11434
MEETINGS_LLM_MODEL=qwen2.5:7b
```

资源要求（参考）：

| 服务 | CPU | 内存 | 磁盘 |
| --- | --- | --- | --- |
| ASR（sherpa zipformer small，2 线程） | 2 核 | ≥ 2 GB | 模型约 1 GB（asr-models 卷） |
| Ollama（qwen2.5:7b） | 4 核建议 | ≥ 8 GB | 模型约 5 GB |

## 离线环境

预先下载模型并挂载到 `asr-models` 卷（`/models`）。模型目录必须同时包含
`tokens.txt`、`*encoder*.onnx`、`*decoder*.onnx`、`*joiner*.onnx`；`entrypoint.sh` 检测到不完整会
重新下载并报错，**目录存在不等于模型完整**。

## 验收

- 容器启动后 `docker compose ps` 显示 `healthy`（健康检查确认端口可达；模型加载失败容器会启动失败）；
- 后端 `.env.local` 配置 `MEETINGS_ASR_URL=ws://asr:10095`（同网络）后，前端开始录音能产生实时转写；
- 暂停/继续/断线重连后转写不重复、不落句；结束后最终句入库。
