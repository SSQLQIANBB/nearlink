"""Explicit local Windows capture/encode/decode acceptance; no network or saved frames.

Run with the isolated, pinned GStreamer Python environment. This probe does not
enable a product entry point or substitute for signed session/transport tests.
"""
import importlib.util
import faulthandler
import json
from pathlib import Path
import sys
import tempfile
import time


def main():
    faulthandler.enable()
    if sys.platform != "win32":
        raise SystemExit("Windows interactive desktop required")
    spec = importlib.util.spec_from_file_location(
        "remote_host", Path(__file__).with_name("remote-control-host-engine.py"))
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    with tempfile.TemporaryDirectory(prefix="nearlink-windows-media-") as temporary:
        _, gst, _, _, sdk = host.load_sdk(str(Path(temporary) / "registry.bin"))
        for package, plugin in (("gstreamer_plugins", "d3d11"),
                                ("gstreamer_plugins", "mediafoundation"),
                                ("gstreamer_libs", "videoconvertscale"),
                                ("gstreamer_plugins", "openh264")):
            gst.Plugin.load_file(str(sdk / package / "lib/gstreamer-1.0" / f"gst{plugin}.dll"))
        pipeline = gst.parse_launch(
            "d3d11screencapturesrc monitor-index=-1 show-cursor=true ! "
            "video/x-raw(memory:D3D11Memory),framerate=15/1 ! d3d11download ! "
            "videoconvert ! videoscale add-borders=true ! "
            "video/x-raw,format=NV12,width=1280,height=720,pixel-aspect-ratio=1/1 ! "
            "mfh264enc bitrate=2000 low-latency=true ! "
            "video/x-h264,profile=baseline ! h264parse ! openh264dec ! "
            "videoconvert ! video/x-raw,format=BGRA ! "
            "appsink name=decoded sync=false max-buffers=2 drop=true")
        frames = 0
        started = time.monotonic()
        first_frame_ms = None
        last_pts = None
        try:
            if pipeline.set_state(gst.State.PLAYING) == gst.StateChangeReturn.FAILURE:
                raise RuntimeError("WINDOWS_MEDIA_START_FAILED")
            sink, bus = pipeline.get_by_name("decoded"), pipeline.get_bus()
            while frames < 30 and time.monotonic() - started < 20:
                error = bus.pop_filtered(gst.MessageType.ERROR)
                if error:
                    failure, _ = error.parse_error()
                    raise RuntimeError(str(failure))
                sample = sink.emit("try-pull-sample", gst.SECOND)
                if sample is None:
                    continue
                caps = sample.get_caps().get_structure(0)
                if (caps.get_value("width"), caps.get_value("height")) != (1280, 720):
                    raise RuntimeError("WINDOWS_MEDIA_DIMENSIONS_INVALID")
                buffer = sample.get_buffer()
                if buffer.get_size() != 1280 * 720 * 4:
                    raise RuntimeError("WINDOWS_MEDIA_FRAME_INVALID")
                if buffer.pts == gst.CLOCK_TIME_NONE or (last_pts is not None and buffer.pts <= last_pts):
                    raise RuntimeError("WINDOWS_MEDIA_FRAME_NOT_ADVANCING")
                last_pts = buffer.pts
                if frames == 0:
                    pixels = buffer.extract_dup(0, buffer.get_size())
                    if not any(pixels[0::4]) and not any(pixels[1::4]) and not any(pixels[2::4]):
                        raise RuntimeError("WINDOWS_MEDIA_TEST_DESKTOP_IS_BLACK")
                frames += 1
                if first_frame_ms is None:
                    first_frame_ms = round((time.monotonic() - started) * 1000)
            if frames != 30:
                raise RuntimeError("WINDOWS_MEDIA_FRAME_TIMEOUT")
        finally:
            pipeline.set_state(gst.State.NULL)
            _, current, _ = pipeline.get_state(5 * gst.SECOND)
            if current != gst.State.NULL:
                raise RuntimeError("WINDOWS_MEDIA_STOP_FAILED")
        print(json.dumps({"frames": frames, "width": 1280, "height": 720,
                          "firstFrameMs": first_frame_ms, "stopped": True,
                          "networkUsed": False, "framesSaved": False}))


if __name__ == "__main__":
    main()
