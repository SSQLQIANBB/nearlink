"""Windows source for the supervised engine's existing H.264 pipe contract.

Development runtime only until included in a verified fixed engine bundle.
No networking or input injection. The parent starts this process only after a
media lease; losing its pipe/heartbeat stops capture independently.
"""
import ctypes
from ctypes import wintypes
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time


def load_host():
    spec = importlib.util.spec_from_file_location(
        "host_engine", Path(__file__).with_name("remote-control-host-engine.py"))
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    return host


class DisplayMode(ctypes.Structure):
    # DEVMODEW's display union has the same 16-byte size as its printer union.
    _fields_ = [("name", wintypes.WCHAR * 32), ("spec", wintypes.WORD),
                ("driver", wintypes.WORD), ("size", wintypes.WORD),
                ("extra", wintypes.WORD), ("fields", wintypes.DWORD),
                ("x", wintypes.LONG), ("y", wintypes.LONG),
                ("orientation", wintypes.DWORD), ("fixed", wintypes.DWORD),
                ("color", wintypes.SHORT), ("duplex", wintypes.SHORT),
                ("resolution", wintypes.SHORT), ("tt", wintypes.SHORT),
                ("collate", wintypes.SHORT), ("form", wintypes.WCHAR * 32),
                ("dpi", wintypes.WORD), ("bpp", wintypes.DWORD),
                ("width", wintypes.DWORD), ("height", wintypes.DWORD),
                ("flags", wintypes.DWORD), ("frequency", wintypes.DWORD),
                ("icm", wintypes.DWORD), ("intent", wintypes.DWORD),
                ("media", wintypes.DWORD), ("dither", wintypes.DWORD),
                ("reserved1", wintypes.DWORD), ("reserved2", wintypes.DWORD),
                ("panningWidth", wintypes.DWORD), ("panningHeight", wintypes.DWORD)]


class Desktop:
    def __init__(self):
        self.api = ctypes.WinDLL("user32", use_last_error=True)
        self.api.EnumDisplaySettingsW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(DisplayMode)]
        self.api.EnumDisplaySettingsW.restype = wintypes.BOOL
        self.api.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.api.OpenInputDesktop.restype = wintypes.HANDLE
        self.api.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        self.api.GetUserObjectInformationW.restype = wintypes.BOOL
        self.api.CloseDesktop.argtypes = [wintypes.HANDLE]
        self.api.CloseDesktop.restype = wintypes.BOOL

    def snapshot(self):
        handle = self.api.OpenInputDesktop(0, False, 1)  # DESKTOP_READOBJECTS
        if not handle:
            raise RuntimeError("INTERACTIVE_DESKTOP_UNAVAILABLE")
        try:
            name, needed = ctypes.create_unicode_buffer(256), wintypes.DWORD()
            if not self.api.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed)) or name.value != "Default":
                raise RuntimeError("INTERACTIVE_DESKTOP_UNAVAILABLE")
        finally:
            self.api.CloseDesktop(handle)
        mode = DisplayMode(size=ctypes.sizeof(DisplayMode))
        if not self.api.EnumDisplaySettingsW(None, 0xFFFFFFFF, ctypes.byref(mode)):
            raise RuntimeError("MEDIA_LAYOUT_UNAVAILABLE")
        if not (0 < mode.width <= 16384 and 0 < mode.height <= 16384 and mode.orientation in range(4)):
            raise RuntimeError("MEDIA_LAYOUT_INVALID")
        return (mode.x, mode.y, mode.width, mode.height, mode.orientation * 90)


def layout(snapshot):
    x, y, width, height, rotation = snapshot
    ratio = min(1280 / width, 720 / height)
    # Explicit even content dimensions keep NV12 chroma and input mapping aligned.
    content_width = max(2, int(width * ratio) // 2 * 2)
    content_height = max(2, int(height * ratio) // 2 * 2)
    left, top = (1280 - content_width) // 4 * 2, (720 - content_height) // 4 * 2
    return {"type": "screen-source-layout", "screenId": "primary", "layoutVersion": 1,
            "geometry": {"displayId": 1, "coordinateSpace": "windows-desktop-physical",
                         "displayBounds": {"x": x, "y": y, "width": width, "height": height},
                         "displayPixels": {"width": width, "height": height},
                         "rotationDegrees": rotation, "encodedSize": {"width": 1280, "height": 720},
                         "contentRect": {"x": left, "y": top, "width": content_width, "height": content_height}}}


class Supervisor:
    def __init__(self, host):
        self.host = host
        self.stopped = threading.Event()
        self.reason = "LOCAL_STOP"

    def stop(self, reason):
        if not self.stopped.is_set():
            self.reason = reason
            self.stopped.set()

    def watch(self):
        deadline, pending = time.monotonic() + 3, bytearray()
        try:
            while not self.stopped.is_set():
                if time.monotonic() >= deadline:
                    self.stop("SUPERVISOR_TIMEOUT")
                    return
                if not self.host.wait_pipe_readable(sys.stdin.fileno(), 0.05):
                    continue
                chunk = os.read(sys.stdin.fileno(), 64)
                if not chunk:
                    self.stop("SUPERVISOR_PIPE_CLOSED")
                    return
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, rest = pending.partition(b"\n")
                    pending = bytearray(rest)
                    if line == b"heartbeat":
                        deadline = time.monotonic() + 3
                    else:
                        self.stop("LOCAL_STOP" if line == b"stop" else "INVALID_SUPERVISOR_MESSAGE")
                        return
                if len(pending) > 16:
                    self.stop("INVALID_SUPERVISOR_MESSAGE")
        except OSError:
            self.stop("SUPERVISOR_PIPE_CLOSED")


def run(host, sdk, supervisor):
    _, gst, root = sdk
    for package, plugin in (("gstreamer_plugins", "d3d11"),
                            ("gstreamer_plugins", "mediafoundation"),
                            ("gstreamer_libs", "videoconvertscale"),
                            ("gstreamer_plugins", "videobox"),
                            ("gstreamer_plugins", "videoparsersbad")):
        gst.Plugin.load_file(str(root / package / "lib/gstreamer-1.0" / f"gst{plugin}.dll"))
    desktop = Desktop()
    initial = desktop.snapshot()
    message = layout(initial)
    host.MediaLayoutTracker().source(message)
    rect = message["geometry"]["contentRect"]
    pipeline = gst.parse_launch(
        "d3d11screencapturesrc name=capture monitor-index=-1 show-cursor=true ! "
        "video/x-raw(memory:D3D11Memory),framerate=15/1 ! d3d11download ! "
        "videoconvert ! videoscale ! "
        f"video/x-raw,format=I420,width={rect['width']},height={rect['height']},pixel-aspect-ratio=1/1 ! "
        f"videobox left={-rect['x']} top={-rect['y']} right={-(1280-rect['width']-rect['x'])} bottom={-(720-rect['height']-rect['y'])} ! "
        "videoconvert ! video/x-raw,format=NV12,width=1280,height=720 ! "
        "mfh264enc bitrate=2000 low-latency=true ! video/x-h264,profile=baseline,level=(string)3.1 ! "
        "h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! "
        "appsink name=encoded sync=false max-buffers=2 drop=false")
    lock = threading.Lock()
    progress = {"type": "screen-source-progress", "captureSeq": 0, "captureMonotonicNs": 0,
                "encodedSeq": 0, "encodedMonotonicNs": 0}
    def captured(_pad, _info):
        with lock:
            progress["captureSeq"] += 1
            progress["captureMonotonicNs"] = host.clock_ns()
        return gst.PadProbeReturn.OK
    pipeline.get_by_name("capture").get_static_pad("src").add_probe(gst.PadProbeType.BUFFER, captured)
    sink, bus = pipeline.get_by_name("encoded"), pipeline.get_bus()
    def report(value):
        host.write_pipe(sys.stderr.fileno(), json.dumps(value).encode() + b"\n", 0.1)
    report(message)
    first_pts, last_pts = None, None
    last_report, frames, byte_count = time.monotonic(), 0, 0
    capture_started = host.clock_ns()
    try:
        if supervisor.stopped.is_set():
            return
        if pipeline.set_state(gst.State.PLAYING) == gst.StateChangeReturn.FAILURE:
            raise RuntimeError("CAPTURE_START_FAILED")
        while not supervisor.stopped.is_set():
            with lock:
                last_capture = progress["captureMonotonicNs"] or capture_started
            if host.clock_ns() - last_capture >= 12_000_000_000:
                raise RuntimeError("CAPTURE_TIMEOUT")
            if desktop.snapshot() != initial:
                raise RuntimeError("MEDIA_LAYOUT_CHANGED")
            if bus.pop_filtered(gst.MessageType.ERROR | gst.MessageType.EOS):
                raise RuntimeError("CAPTURE_PIPELINE_FAILED")
            sample = sink.emit("try-pull-sample", gst.SECOND // 10)
            if sample is not None:
                buffer = sample.get_buffer()
                if buffer.pts == gst.CLOCK_TIME_NONE or (last_pts is not None and buffer.pts <= last_pts):
                    raise RuntimeError("ENCODED_TIMESTAMP_INVALID")
                if first_pts is None:
                    # MF starts at a 1000-hour offset. The parent appsrc uses a
                    # different pipeline clock; keep intervals, not that epoch.
                    first_pts = buffer.pts
                size = buffer.get_size()
                if not 0 < size <= host.MAX_FRAME_BYTES:
                    raise RuntimeError("ENCODED_FRAME_LIMIT")
                if supervisor.stopped.is_set():
                    break
                if desktop.snapshot() != initial:
                    raise RuntimeError("MEDIA_LAYOUT_CHANGED")
                host.write_pipe(sys.stdout.fileno(), struct.pack(">IQ", size, buffer.pts - first_pts) + buffer.extract_dup(0, size), 0.1)
                last_pts = buffer.pts
                frames, byte_count = frames + 1, byte_count + size
                with lock:
                    progress["encodedSeq"] += 1
                    progress["encodedMonotonicNs"] = host.clock_ns()
            if time.monotonic() - last_report >= 0.25:
                with lock:
                    snapshot = dict(progress)
                report({**snapshot, "captureMonotonicNs": str(snapshot["captureMonotonicNs"]),
                        "encodedMonotonicNs": str(snapshot["encodedMonotonicNs"])})
                last_report = time.monotonic()
    except (BrokenPipeError, TimeoutError):
        supervisor.stop("OUTPUT_PIPE_CLOSED")
    except RuntimeError as error:
        supervisor.stop(str(error))
        report({"type": "error", "reason": str(error)})
    finally:
        pipeline.set_state(gst.State.NULL)
        _, current, _ = pipeline.get_state(5 * gst.SECOND)
        report({"type": "screen-source-stopped", "reason": supervisor.reason,
                "captureStopped": current == gst.State.NULL, "encodedFrames": frames,
                "encodedBytes": byte_count, "framesStored": 0})


def main():
    if sys.platform != "win32":
        raise SystemExit("Windows required")
    host = load_host()
    os.set_blocking(sys.stdout.fileno(), False)
    os.set_blocking(sys.stderr.fileno(), False)
    supervisor = Supervisor(host)
    watcher = threading.Thread(target=supervisor.watch, daemon=True)
    watcher.start()
    try:
        with tempfile.TemporaryDirectory(prefix="nearlink-windows-source-") as directory:
            run(host, host.load_gst(str(Path(directory) / "registry.bin")), supervisor)
    except Exception:
        host.write_pipe(sys.stderr.fileno(), b'{"type":"error","reason":"WINDOWS_SOURCE_FAILED"}\n', 0.1)
        return 1
    finally:
        supervisor.stop("LOCAL_STOP")
        watcher.join(timeout=0.2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
