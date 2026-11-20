#!/bin/sh
# 会议 ASR 服务入口（sherpa-onnx 唯一引擎）：确保模型完整后启动 WebSocket 服务。
set -e

MODEL_DIR="${ASR_MODEL_DIR:-/models}"
HOST="${ASR_HOST:-0.0.0.0}"
PORT="${ASR_PORT:-10095}"

# sherpa-onnx 实时 zipformer 模型（中文，固定下载地址与版本）。
SHERPA_MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
SHERPA_MODEL_NAME="sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
SHERPA_MODEL_DIR_NAME="sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"

model_complete() {
  d="$MODEL_DIR/$SHERPA_MODEL_DIR_NAME"
  [ -f "$d/tokens.txt" ] || return 1
  ls "$d"/*encoder*.onnx >/dev/null 2>&1 || return 1
  ls "$d"/*decoder*.onnx >/dev/null 2>&1 || return 1
  ls "$d"/*joiner*.onnx >/dev/null 2>&1 || return 1
}

ensure_model() {
  if model_complete; then
    echo "[asr] 模型已就绪：$MODEL_DIR/$SHERPA_MODEL_DIR_NAME"
    return
  fi
  # 目录存在不等于模型完整：不完整时重新下载。
  echo "[asr] 模型缺失或不完整，下载模型到 $MODEL_DIR（离线环境请预先挂载）..."
  if command -v wget >/dev/null 2>&1; then
    wget -q -P "$MODEL_DIR" "$SHERPA_MODEL_URL"
  else
    python -c "import urllib.request; urllib.request.urlretrieve('$SHERPA_MODEL_URL', '$MODEL_DIR/$SHERPA_MODEL_NAME')"
  fi
  if [ -f "$MODEL_DIR/$SHERPA_MODEL_NAME" ]; then
    if command -v tar >/dev/null 2>&1; then
      tar -C "$MODEL_DIR" -xjf "$MODEL_DIR/$SHERPA_MODEL_NAME"
    else
      python -c "import tarfile; tarfile.open('$MODEL_DIR/$SHERPA_MODEL_NAME', 'r:bz2').extractall('$MODEL_DIR')"
    fi
    rm -f "$MODEL_DIR/$SHERPA_MODEL_NAME"
  fi
  if ! model_complete; then
    echo "[asr] 错误：模型下载后仍不完整，请检查网络或预先挂载模型卷" >&2
    exit 1
  fi
  echo "[asr] 模型就绪"
}

ensure_model
echo "[asr] 使用 sherpa-onnx 实时识别，$HOST:$PORT"
exec python /app/sherpa_asr_server.py \
  --model-dir "$MODEL_DIR/$SHERPA_MODEL_DIR_NAME" \
  --host "$HOST" \
  --port "$PORT" \
  --num-threads "${ASR_NUM_THREADS:-2}"
