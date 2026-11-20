"""
会议实时语音识别 WebSocket 服务（sherpa-onnx，唯一引擎，流式）。

协议（与 backend-koa/src/services/asrClient.ts 对齐）：
- 客户端连接后发送二进制帧：PCM16LE 单声道 16kHz，按分片追加（小端）；
- 服务端回 JSON 文本帧：
  {"segmentId": n, "text": "...", "isFinal": false, "startMs": ms, "endMs": null, "speakerId": null}
  同一 segmentId 的 text 为当前句累计文本；句子端点（VAD 静音）后发送 isFinal=true；
- 客户端发送文本帧 {"is_speaking": false} 触发该连接音频结束并输出最终句；
- 健康检查：文本帧 {"health": true} → {"status": "ok", "model_loaded": true}。

依赖（Dockerfile 固定版本）：sherpa-onnx、websockets。
"""
import argparse
import asyncio
import array
import glob
import json
import math
import os
import sys

import websockets
import sherpa_onnx

SAMPLE_RATE = 16000
# 句子端点：静音超过该毫秒数视为一句结束（避免整场会议成为一句临时句）。
END_SILENCE_MS = 540
# 单句最大时长保护。
MAX_SENTENCE_MS = 30_000


def _find_first(root: str, patterns):
    for pat in patterns:
        for sub in (root, os.path.join(root, "exp")):
            hits = sorted(glob.glob(os.path.join(sub, pat)))
            if hits:
                return hits[0]
    return None


def build_recognizer(model_dir: str, num_threads: int):
    """构建 sherpa-onnx 流式（zipformer）识别器；模型必要文件缺失时直接失败。"""
    tokens = _find_first(model_dir, ["tokens.txt"])
    encoder = _find_first(model_dir, ["encoder-*.onnx", "encoder*.onnx"])
    decoder = _find_first(model_dir, ["decoder-*.onnx", "decoder*.onnx"])
    joiner = _find_first(model_dir, ["joiner-*.onnx", "joiner*.onnx"])
    missing = [
        name
        for name, path in [("tokens.txt", tokens), ("encoder", encoder), ("decoder", decoder), ("joiner", joiner)]
        if not path
    ]
    if missing:
        raise SystemExit(f"模型文件不完整，缺少：{', '.join(missing)}（目录 {model_dir}）")

    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=tokens, encoder=encoder, decoder=decoder, joiner=joiner,
        num_threads=num_threads, sample_rate=SAMPLE_RATE, feature_dim=80,
        provider="cpu", decoding_method="greedy_search",
        enable_endpoint_detection=True,
        rule2_min_trailing_silence=END_SILENCE_MS / 1000,
        rule3_min_utterance_length=MAX_SENTENCE_MS / 1000,
    )
    # 目录存在不等于模型完整：加载失败即退出，健康检查依赖启动成功。
    print(f"[asr] 模型加载成功：{encoder}", flush=True)
    return recognizer


def _pcm16_to_float(data: bytes):
    """PCM16LE 转 float。仅当宿主为大端时交换字节。"""
    arr = array.array("h")
    arr.frombytes(data)
    if sys.byteorder == "big":
        arr.byteswap()
    return [v / 32768.0 for v in arr]


async def handle(ws, recognizer):
    stream = recognizer.create_stream()
    segment_id = 0
    total_samples = 0
    start_ms = 0

    def decode_ready():
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)

    async def send_segment(final):
        result = recognizer.get_result_all(stream) if final else None
        text = result.text.strip() if result is not None else recognizer.get_result(stream)
        if text:
            end_ms = total_samples * 1000 // SAMPLE_RATE if final else None
            payload = {
                "segmentId": segment_id, "text": text, "isFinal": final,
                "startMs": start_ms,
                "endMs": end_ms,
                "speakerId": None,
            }
            if (result is not None and len(result.tokens) == len(result.timestamps)
                    and math.isfinite(result.start_time) and all(map(math.isfinite, result.timestamps))):
                # Zipformer 的 token 时间相对于当前识别段，start_time 相对于整条流。
                starts = [round((result.start_time + ts) * 1000) for ts in result.timestamps]
                ends = starts[1:] + [end_ms]
                words = [
                    {"text": token, "startMs": start, "endMs": min(end, end_ms)}
                    for raw, start, end in zip(result.tokens, starts, ends)
                    if (token := raw.replace("▁", " ").strip()) and 0 <= start < min(end, end_ms)
                ]
                if words:
                    payload["startMs"] = min(start_ms, words[0]["startMs"])
                    payload["words"] = words
            await ws.send(json.dumps(payload, ensure_ascii=False))

    try:
        async for raw in ws:
            if isinstance(raw, (bytes, bytearray)):
                if len(raw) % 2:
                    await ws.close(code=1003, reason="PCM16 requires complete samples")
                    return
                samples = _pcm16_to_float(raw)
                if not samples:
                    continue
                total_samples += len(samples)
                stream.accept_waveform(SAMPLE_RATE, samples)
                decode_ready()
                if recognizer.is_endpoint(stream):
                    await send_segment(True)
                    recognizer.reset(stream)
                    segment_id += 1
                    start_ms = total_samples * 1000 // SAMPLE_RATE
                else:
                    await send_segment(False)
            else:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("health") is True:
                    await ws.send(json.dumps({"status": "ok", "model_loaded": True}))
                elif msg.get("is_speaking") is False:
                    # 按锁定版本官方示例补齐特征窗口，input_finished 后排空可解码帧。
                    # 补零不计入实际音频时长，时间戳始终基于本连接真实输入样本。
                    stream.accept_waveform(SAMPLE_RATE, [0.0] * int(0.3 * SAMPLE_RATE))
                    stream.input_finished()
                    decode_ready()
                    await send_segment(True)
                    await ws.send(json.dumps({"isInputDone": True}))
                    return
    except websockets.ConnectionClosed:
        pass


async def main(args):
    recognizer = build_recognizer(args.model_dir, args.num_threads)
    print(f"[asr] 实时识别服务启动：{args.host}:{args.port}（sherpa-onnx 流式）", flush=True)

    async def handler(ws):
        await handle(ws, recognizer)

    async with websockets.serve(handler, args.host, args.port):
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=10095)
    parser.add_argument("--num-threads", type=int, default=2)
    args = parser.parse_args()
    asyncio.run(main(args))
