# 会议实时语音识别（sherpa-onnx）
#
# 引擎：sherpa-onnx 流式 zipformer（唯一引擎）。
# 模型不内置进镜像（体积大），首次启动自动从固定地址下载并校验必要文件到挂载卷 /models；
# 离线环境可预先下载并挂载到该目录。
#
# 构建上下文：仓库根目录。构建：
#   docker build -f deploy/asr/Dockerfile -t nearlink-asr .

FROM python:3.10-slim

# 固定依赖版本，保证可复现部署。
ENV PIP_NO_CACHE_DIR=1 \
    ASR_HOST=127.0.0.1 \
    ASR_PORT=10095 \
    ASR_MODEL_DIR=/models \
    ASR_NUM_THREADS=2

WORKDIR /app
COPY deploy/asr/sherpa_asr_server.py /app/sherpa_asr_server.py
COPY deploy/asr/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN pip install --no-cache-dir \
    sherpa-onnx==1.10.42 \
    websockets==12.0

VOLUME ["/models"]
EXPOSE 10095

# 健康检查：TCP 可达且服务完成模型加载（模型加载失败时容器无法启动）。
HEALTHCHECK --interval=15s --timeout=5s --start-period=300s --retries=20 \
  CMD python -c "import socket,sys; s=socket.create_connection(('127.0.0.1', int(__import__('os').environ.get('ASR_PORT','10095'))), 3); s.close()" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
