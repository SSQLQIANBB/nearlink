"""Development-only supervised GStreamer host. No OS input, disk media, or public API.

The fixed source executable is supplied by the native supervisor at process launch.
Only a MAC-authenticated start-media command can start it. The temporary Python
SDK is a validation dependency, not a signed or distributable production sidecar.
"""
import argparse
import base64
import ctypes
import copy
import faulthandler
import hashlib
import ipaddress
from urllib.parse import quote
import math
import os
from pathlib import Path
import queue
import re
import select
import signal
import ssl
import struct
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time

from remote_control_ipc import HostIpc, MAX_LINE_BYTES, _json as strict_json

LABELS = {"rc-state-v1", "rc-input-v1"}
MAX_CHANNEL_BYTES = 4096
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_PENDING = 32
MAX_SAFE_SEQUENCE = 9_007_199_254_740_991
MAX_U64 = (1 << 64) - 1


def clock_ns():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


class IpcLineFramer:
    def __init__(self):
        self.buffered = bytearray()

    def feed(self, chunk):
        self.buffered.extend(chunk)
        lines = []
        while True:
            newline = self.buffered.find(b"\n")
            if newline < 0:
                break
            length = newline + 1
            if length > MAX_LINE_BYTES:
                raise ValueError("IPC_LINE_LIMIT")
            lines.append(bytes(self.buffered[:length]))
            del self.buffered[:length]
        # Check the remaining incomplete line only after extracting full frames.
        if len(self.buffered) > MAX_LINE_BYTES:
            raise ValueError("IPC_LINE_LIMIT")
        return lines


class MediaProgressTracker:
    """Event timestamps only. Repeated reports and cached-frame encoding are not capture activity."""
    def __init__(self):
        self.lock = threading.Lock()
        self.stages = {name: (0, 0) for name in ("capture", "encoded", "forwarded")}

    @staticmethod
    def validate(seq, timestamp, prior, now_ns):
        if (type(seq) is not int or not 0 <= seq <= MAX_SAFE_SEQUENCE or not isinstance(timestamp, str)
                or not re.fullmatch(r"0|[1-9][0-9]{0,19}", timestamp)):
            raise ValueError("INVALID_MEDIA_PROGRESS")
        observed = int(timestamp)
        if observed > MAX_U64 or observed > now_ns or ((seq == 0) != (observed == 0)):
            raise ValueError("INVALID_MEDIA_PROGRESS")
        old_seq, old_observed = prior
        if seq < old_seq or (seq == old_seq and observed != old_observed) or (seq > old_seq and observed <= old_observed):
            raise ValueError("MEDIA_PROGRESS_REGRESSION")
        return seq, observed

    def source(self, message, now_ns):
        if set(message) != {"type", "captureSeq", "captureMonotonicNs", "encodedSeq", "encodedMonotonicNs"} or message["type"] != "screen-source-progress":
            raise ValueError("INVALID_SOURCE_PROGRESS")
        with self.lock:
            updates = {name: self.validate(message[f"{name}Seq"], message[f"{name}MonotonicNs"], self.stages[name], now_ns)
                       for name in ("capture", "encoded")}
            self.stages.update(updates)

    def forwarded(self, now_ns):
        with self.lock:
            seq, observed = self.stages["forwarded"]
            if seq >= MAX_SAFE_SEQUENCE or not 0 < now_ns <= MAX_U64 or now_ns <= observed:
                raise ValueError("INVALID_FORWARD_PROGRESS")
            self.stages["forwarded"] = seq + 1, now_ns

    def snapshot(self):
        with self.lock:
            return {field: value for name, (seq, observed) in self.stages.items()
                    for field, value in [(f"{name}Seq", seq), (f"{name}MonotonicNs", str(observed))]}


class MediaLayoutTracker:
    """A source-observed, immutable primary-screen layout; never supplied by IPC."""
    def __init__(self):
        self.lock = threading.Lock()
        self.value = None

    @staticmethod
    def validate(value):
        def keys(item, names):
            if type(item) is not dict or set(item) != set(names):
                raise ValueError("INVALID_MEDIA_LAYOUT")

        def integer(number, minimum, maximum):
            if type(number) is not int or not minimum <= number <= maximum:
                raise ValueError("INVALID_MEDIA_LAYOUT")

        def finite(number):
            if type(number) not in {int, float} or not math.isfinite(number):
                raise ValueError("INVALID_MEDIA_LAYOUT")

        def rect(item):
            keys(item, ("x", "y", "width", "height"))
            for number in item.values():
                finite(number)
            if not 0 < item["width"] <= 16_384 or not 0 < item["height"] <= 16_384:
                raise ValueError("INVALID_MEDIA_LAYOUT")
            finite(item["x"] + item["width"])
            finite(item["y"] + item["height"])

        keys(value, ("screenId", "layoutVersion", "geometry"))
        if value["screenId"] != "primary":
            raise ValueError("INVALID_MEDIA_LAYOUT")
        integer(value["layoutVersion"], 1, MAX_SAFE_SEQUENCE)
        geometry = value["geometry"]
        keys(geometry, ("displayId", "coordinateSpace", "displayBounds", "displayPixels", "rotationDegrees", "encodedSize", "contentRect"))
        integer(geometry["displayId"], 1, (1 << 32) - 1)
        if geometry["coordinateSpace"] != "quartz-global-logical":
            raise ValueError("INVALID_MEDIA_LAYOUT")
        integer(geometry["rotationDegrees"], 0, 270)
        if geometry["rotationDegrees"] not in {0, 90, 180, 270}:
            raise ValueError("INVALID_MEDIA_LAYOUT")
        rect(geometry["displayBounds"])
        rect(geometry["contentRect"])
        bounds = geometry["displayBounds"]
        if (bounds["width"] < 1 or bounds["height"] < 1
                or abs(bounds["x"]) > 1_000_000 or abs(bounds["y"]) > 1_000_000):
            raise ValueError("INVALID_MEDIA_LAYOUT")
        for name in ("displayPixels", "encodedSize"):
            size = geometry[name]
            keys(size, ("width", "height"))
            for dimension in size.values():
                integer(dimension, 1, 16_384)
        content, encoded = geometry["contentRect"], geometry["encodedSize"]
        if (content["x"] < 0 or content["y"] < 0 or content["x"] + content["width"] > encoded["width"]
                or content["y"] + content["height"] > encoded["height"]):
            raise ValueError("INVALID_MEDIA_LAYOUT")

    def source(self, message):
        if type(message) is not dict or set(message) != {"type", "screenId", "layoutVersion", "geometry"} or message["type"] != "screen-source-layout":
            raise ValueError("INVALID_MEDIA_LAYOUT")
        value = {key: message[key] for key in ("screenId", "layoutVersion", "geometry")}
        self.validate(value)
        with self.lock:
            if self.value is not None and self.value != value:
                raise ValueError("MEDIA_LAYOUT_CHANGED")
            self.value = copy.deepcopy(value)

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.value)


def certificate_fingerprint(pem):
    """Hash actual transport certificate DER. Never echo a fingerprint from SDP."""
    if not isinstance(pem, str) or len(pem) > 65536:
        raise ValueError("DTLS_CERTIFICATE_UNAVAILABLE")
    match = re.search(r"-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----", pem)
    if not match:
        raise ValueError("DTLS_CERTIFICATE_UNAVAILABLE")
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(match.group(0))).hexdigest().upper()


def loopback_candidate(candidate):
    if not isinstance(candidate, str) or len(candidate.encode()) > 4096 or "\n" in candidate or "\r" in candidate:
        return False
    fields = candidate.split()
    try:
        return (len(fields) >= 8 and fields[0].startswith("candidate:") and fields[6:8] == ["typ", "host"]
                and fields[2].lower() in {"udp", "tcp"} and ipaddress.ip_address(fields[4]).is_loopback
                and 0 < int(fields[5]) <= 65535 and "raddr" not in fields and "rport" not in fields)
    except (ValueError, IndexError):
        return False


def network_candidate(candidate, policy="loopback"):
    if policy == "loopback":
        return loopback_candidate(candidate)
    if not isinstance(candidate, str) or len(candidate) > 4096 or any(c in candidate for c in "\r\n\0"):
        return False
    p = candidate.split()
    try:
        address = ipaddress.ip_address(p[4])
        if (len(p) < 8 or not p[0].startswith("candidate:") or len(p[0]) <= 10 or p[1] != "1"
                or p[2].lower() not in {"udp", "tcp"} or not 0 < int(p[3]) <= 0xffffffff
                or not 0 < int(p[5]) <= 65535 or p[6] != "typ" or p[7] not in {"host", "srflx", "prflx", "relay"}
                or address.is_unspecified or address.is_multicast or (len(p) - 8) % 2):
            return False
        for key, value in zip(p[8::2], p[9::2]):
            if key == "raddr": ipaddress.ip_address(value)
            if key == "rport" and not 0 <= int(value) <= 65535: return False
        return True
    except (ValueError, IndexError):
        return False


def ice_configuration(payload, now_ms):
    """Validated native IPC input only. Never log or put these URIs on argv."""
    if (not isinstance(payload, dict) or set(payload) != {"iceServers", "iceTransportPolicy", "expiresAt"}
            or payload["iceTransportPolicy"] not in {"all", "relay"} or type(payload["expiresAt"]) is not int
            or not now_ms < payload["expiresAt"] <= now_ms + 3_900_000
            or not isinstance(payload["iceServers"], list) or not 1 <= len(payload["iceServers"]) <= 4):
        raise ValueError("INVALID_ICE_CONFIGURATION")
    stun, turns = None, []
    for server in payload["iceServers"]:
        if (not isinstance(server, dict) or not set(server) <= {"urls", "username", "credential"}
                or not isinstance(server.get("urls"), list) or not 1 <= len(server["urls"]) <= 4):
            raise ValueError("INVALID_ICE_CONFIGURATION")
        kinds = set()
        for url in server["urls"]:
            match = re.fullmatch(r"(stun|turn|turns):([a-zA-Z0-9.-]+):([0-9]{1,5})(?:\?transport=(udp|tcp))?", url) if isinstance(url, str) and len(url) <= 512 else None
            if not match: raise ValueError("INVALID_ICE_CONFIGURATION")
            scheme, host, port, transport = match.groups()
            if (not 0 < int(port) <= 65535 or len(host) > 253
                    or any(not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label) for label in host.split('.'))
                    or (scheme == "stun" and transport is not None) or (scheme != "stun" and transport is None)
                    or (scheme == "turns" and transport != "tcp")):
                raise ValueError("INVALID_ICE_CONFIGURATION")
            kinds.add(scheme != "stun")
            if scheme == "stun":
                if stun is not None or "username" in server or "credential" in server: raise ValueError("INVALID_ICE_CONFIGURATION")
                stun = f"stun://{host}:{port}"
            else:
                for key in ["username", "credential"]:
                    if not isinstance(server.get(key), str) or not re.fullmatch(r"[\x21-\x7e]{1,256}", server[key]):
                        raise ValueError("INVALID_ICE_CONFIGURATION")
                turns.append(f"{scheme}://{quote(server['username'], safe='')}:{quote(server['credential'], safe='')}@{host}:{port}?transport={transport}")
        if len(kinds) != 1: raise ValueError("INVALID_ICE_CONFIGURATION")
    if not turns: raise ValueError("INVALID_ICE_CONFIGURATION")
    return stun, turns


def h264_payload(sdp, policy="loopback"):
    if not isinstance(sdp, str) or not 0 < len(sdp.encode()) <= 65536:
        raise ValueError("INVALID_SDP")
    sections = re.split(r"(?m)^m=", sdp)
    videos = [section for section in sections[1:] if section.startswith("video ")]
    if len(videos) != 1 or any(section.startswith("audio ") for section in sections[1:]):
        raise ValueError("UNSUPPORTED_MEDIA")
    # Embedded and trickle ICE use the same native-authorized network policy.
    if any(not network_candidate(line[2:], policy) for line in sdp.splitlines() if line.startswith("a=candidate:")):
        raise ValueError("NON_LOOPBACK_ICE")
    video = videos[0]
    fmtp = {int(value): dict(part.strip().split("=", 1) for part in params.split(";") if "=" in part)
            for value, params in re.findall(r"a=fmtp:(\d+) ([^\r\n]+)", video)}
    payload = next((int(value) for value in re.findall(r"a=rtpmap:(\d+) H264/90000", video, re.I)
                    if fmtp.get(int(value), {}).get("packetization-mode") == "1"
                    and fmtp.get(int(value), {}).get("profile-level-id", "").lower() == "42e01f"), None)
    if payload is None or not 0 <= payload <= 127:
        raise ValueError("H264_BASELINE_REQUIRED")
    return payload


class MediaDeadline:
    def __init__(self):
        self.seq = 0
        self.deadline = None
        self.terminal = False

    def install(self, payload, received_ns, now_ns):
        if self.terminal or (self.deadline is not None and now_ns >= self.deadline):
            self.terminal = True
            raise ValueError("MEDIA_LEASE_EXPIRED")
        if set(payload) != {"mediaLeaseSeq", "ttlMs", "monotonicDeadlineNs"}:
            raise ValueError("INVALID_MEDIA_LEASE")
        seq, ttl, absolute = payload["mediaLeaseSeq"], payload["ttlMs"], payload["monotonicDeadlineNs"]
        if (type(seq) is not int or not self.seq < seq <= 9007199254740991 or type(ttl) is not int
                or not 0 < ttl <= 15000 or not isinstance(absolute, str) or not re.fullmatch(r"[0-9]{1,20}", absolute)):
            raise ValueError("INVALID_MEDIA_LEASE")
        deadline = min(received_ns + ttl * 1_000_000, int(absolute))
        if now_ns >= deadline:
            self.terminal = True
            raise ValueError("MEDIA_LEASE_EXPIRED")
        self.seq, self.deadline = seq, deadline

    def alive(self, now_ns):
        return not self.terminal and self.deadline is not None and now_ns < self.deadline


def load_sdk(registry, sdk_root=None):
    os.environ.update(GST_PLUGIN_SYSTEM_PATH_1_0="", GST_PLUGIN_PATH_1_0="",
                      GST_REGISTRY_1_0=registry, GST_REGISTRY_FORK="no")
    import gi
    gi.require_version("Gst", "1.0")
    gi.require_version("GstSdp", "1.0")
    gi.require_version("GstWebRTC", "1.0")
    from gi.repository import GLib, Gst, GstSdp, GstWebRTC
    Gst.init(None)
    sdk = Path(sdk_root) if sdk_root is not None else Path(sysconfig.get_paths()["purelib"])
    for package, names in [("gstreamer_libs", ["coreelements", "app"]),
                           ("gstreamer_plugins", ["videoparsersbad", "rtp", "rtpmanager", "nice", "dtls", "srtp", "sctp", "webrtc"])]:
        for name in names:
            Gst.Plugin.load_file(str(sdk / package / "lib/gstreamer-1.0" / f"libgst{name}.dylib"))
    return GLib, Gst, GstSdp, GstWebRTC, sdk


def bind_loopback(peer, sdk):
    nice = ctypes.CDLL(str(sdk / "gstreamer_plugins_libs/lib/libnice.10.dylib"))
    nice.nice_address_new.restype = ctypes.c_void_p
    nice.nice_address_set_from_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    nice.nice_address_set_from_string.restype = ctypes.c_int
    nice.nice_agent_add_local_address.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    nice.nice_agent_add_local_address.restype = ctypes.c_int
    nice.nice_address_free.argtypes = [ctypes.c_void_p]
    pointer = ctypes.pythonapi.PyCapsule_GetPointer
    pointer.argtypes = [ctypes.py_object, ctypes.c_char_p]
    pointer.restype = ctypes.c_void_p
    ice_agent = peer.get_property("ice-agent")
    agent = ice_agent.get_property("agent")
    address = nice.nice_address_new()
    try:
        if not nice.nice_address_set_from_string(address, b"127.0.0.1") or not nice.nice_agent_add_local_address(pointer(agent.__gpointer__, None), address):
            raise ValueError("LOOPBACK_BIND_FAILED")
    finally:
        nice.nice_address_free(address)
    # Keep GI wrappers and their plugin library alive for the entire native peer.
    return ice_agent, agent, nice


class Engine:
    def __init__(self, codec, source, sdk_modules, *, source_args=(), test_source_faults=False,
                 test_forward_freeze_after_ms=None):
        self.codec, self.source = codec, source
        self.source_args = tuple(source_args)
        self.test_source_faults = test_source_faults
        if (self.source_args or test_forward_freeze_after_ms is not None) and not test_source_faults:
            raise ValueError("TEST_SOURCE_ARGUMENTS_DISABLED")
        if test_forward_freeze_after_ms is not None and (type(test_forward_freeze_after_ms) is not int
                                                       or not 0 <= test_forward_freeze_after_ms <= 40_000):
            raise ValueError("INVALID_TEST_FORWARD_FREEZE")
        self.test_forward_freeze_after_ns = None if test_forward_freeze_after_ms is None else test_forward_freeze_after_ms * 1_000_000
        self.test_forward_freeze_announced = False
        self.media_started_at_ns = None
        self.GLib, self.Gst, self.GstSdp, self.WebRTC, sdk = sdk_modules
        self.loop = self.GLib.MainLoop()
        self.closed = threading.Event()
        self.write_lock = threading.Lock()
        self.pending = queue.Queue(MAX_PENDING)
        self.channels = {}
        self.offer_received = False
        self.remote_set = False
        self.ice_count = 0
        self.pending_ice = []
        self.dtls = None
        self.media = MediaDeadline()
        self.progress = MediaProgressTracker()
        self.layout = MediaLayoutTracker()
        self.screen = None
        self.screen_stats = None
        self.diagnostics_thread = None
        self.frames = 0
        self.bytes = 0
        self.reason = "STOPPED"
        self.last_heartbeat = clock_ns()
        # VT hardware/software emit equivalent constrained-baseline SPS values
        # 42c01f/42e01f. Gst caps compare strings, so retain both locally while
        # SDP selects the offered 42e01f. Do not rewrite SPS constraint bits.
        # No STAP-A aggregation: system WKWebView received RTP but assembled no
        # video frames with zero-latency aggregation in the real-device probe.
        self.pipeline = self.Gst.parse_launch(
            'webrtcbin name=peer bundle-policy=max-bundle '
            'appsrc name=screen is-live=true format=time block=false max-bytes=4194304 '
            'caps=video/x-h264,stream-format=byte-stream,alignment=au,width=1280,height=720,framerate=15/1 ! '
            'h264parse ! rtph264pay name=screenpay pt=96 config-interval=-1 aggregate-mode=none ! '
            'queue max-size-buffers=5 max-size-bytes=0 max-size-time=0 ! '
            'capsfilter name=screenrtp caps="application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000,packetization-mode=(string)1,profile-level-id=(string){42e01f,42c01f}" ! peer.')
        self.peer = self.pipeline.get_by_name("peer")
        self.sdk = sdk
        self.ice_policy = "loopback"
        self.ice_expires_at = None
        self.ice_agent = self.nice_agent = self.nice_library = None
        self.peer.connect("on-ice-candidate", lambda _p, index, candidate: self.post(self.local_ice, index, candidate))
        # Register on the emitting thread before any open/message notification.
        # Deferring on-data-channel to GLib can lose the controller's first hello.
        self.peer.connect("prepare-data-channel", self.prepare_channel)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self.bus_message)
        os.set_blocking(sys.stdout.fileno(), False)
        self.GLib.timeout_add(10, self.drain)
        self.GLib.timeout_add(100, self.tick)
        self.GLib.timeout_add(250, self.report_progress)

    def fail(self, reason):
        if self.closed.is_set():
            return
        self.reason = reason
        self.closed.set()
        self.media.terminal = True
        # A congested GLib/IPC queue must not postpone stopping the capture process.
        if self.screen is not None and self.screen.poll() is None:
            try:
                self.screen.terminate()
            except ProcessLookupError:
                pass
        self.GLib.idle_add(self.loop.quit)

    def send(self, kind, payload):
        if not self.write_lock.acquire(timeout=0.1):
            self.fail("IPC_BACKPRESSURE")
            return False
        try:
            data = self.codec.encode(kind, payload)
            deadline = time.monotonic() + 0.1
            while data:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([], [sys.stdout.fileno()], [], remaining)[1]:
                    raise TimeoutError()
                try:
                    written = os.write(sys.stdout.fileno(), data)
                    data = data[written:]
                except BlockingIOError:
                    continue
            return True
        except (OSError, ValueError, TimeoutError):
            self.fail("IPC_WRITE_FAILED")
            return False
        finally:
            self.write_lock.release()

    def post(self, function, *args):
        if self.closed.is_set():
            return
        try:
            self.pending.put_nowait((function, args))
        except queue.Full:
            self.fail("ENGINE_BACKPRESSURE")

    def drain(self):
        for _ in range(8):
            try:
                function, args = self.pending.get_nowait()
            except queue.Empty:
                break
            try:
                if not self.closed.is_set():
                    function(*args)
            except Exception:
                self.fail("INVALID_ENGINE_COMMAND")
                break
        return not self.closed.is_set()

    def read_stdin(self):
        framer = IpcLineFramer()
        try:
            while not self.closed.is_set():
                if not select.select([sys.stdin.fileno()], [], [], 0.1)[0]:
                    continue
                chunk = os.read(sys.stdin.fileno(), 8192)
                if not chunk:
                    self.fail("SUPERVISOR_EOF")
                    return
                for line in framer.feed(chunk):
                    message = self.codec.decode(line)
                    received_ns = clock_ns()
                    self.post(self.command, message, received_ns)
        except Exception:
            self.fail("INVALID_IPC")

    def command(self, message, received_ns):
        kind, payload = message["kind"], message["payload"]
        if kind == "heartbeat":
            if payload:
                raise ValueError()
            self.last_heartbeat = received_ns
        elif kind == "configure-ice":
            if self.offer_received or self.ice_policy != "loopback":
                raise ValueError("ICE_CONFIGURATION_REPLAY")
            wall = time.time_ns() // 1_000_000
            stun, turns = ice_configuration(payload, wall)
            self.peer.set_property("ice-transport-policy", self.WebRTC.WebRTCICETransportPolicy.RELAY if payload["iceTransportPolicy"] == "relay" else self.WebRTC.WebRTCICETransportPolicy.ALL)
            if stun and payload["iceTransportPolicy"] == "all": self.peer.set_property("stun-server", stun)
            for uri in turns:
                if not self.peer.emit("add-turn-server", uri): raise ValueError("TURN_CONFIGURATION_FAILED")
            self.ice_policy = payload["iceTransportPolicy"]
            self.ice_expires_at = clock_ns() + (payload["expiresAt"] - wall) * 1_000_000
            self.send("network-configured", {"iceTransportPolicy": self.ice_policy})
        elif kind == "offer":
            if self.offer_received or set(payload) != {"sdp"}:
                raise ValueError()
            value = h264_payload(payload["sdp"], self.ice_policy)
            if self.ice_policy == "loopback":
                self.ice_agent, self.nice_agent, self.nice_library = bind_loopback(self.peer, self.sdk)
            elif clock_ns() >= self.ice_expires_at:
                raise ValueError("ICE_CONFIGURATION_EXPIRED")
            self.offer_received = True
            self.pipeline.get_by_name("screenpay").set_property("pt", value)
            self.pipeline.get_by_name("screenrtp").set_property("caps", self.Gst.Caps.from_string(
                f"application/x-rtp,media=video,encoding-name=H264,payload={value},clock-rate=90000,packetization-mode=(string)1,profile-level-id=(string){{42e01f,42c01f}}"))
            _, sdp = self.GstSdp.SDPMessage.new()
            if self.GstSdp.sdp_message_parse_buffer(payload["sdp"].encode(), sdp) != self.GstSdp.SDPResult.OK:
                raise ValueError()
            description = self.WebRTC.WebRTCSessionDescription.new(self.WebRTC.WebRTCSDPType.OFFER, sdp)
            self.peer.emit("set-remote-description", description, self.Gst.Promise.new_with_change_func(self.description_set_callback, None))
        elif kind == "ice":
            if set(payload) != {"candidate", "sdpMLineIndex"} or type(payload["sdpMLineIndex"]) is not int or not 0 <= payload["sdpMLineIndex"] <= 2 or not network_candidate(payload["candidate"], self.ice_policy):
                raise ValueError()
            self.ice_count += 1
            if self.ice_count > 128:
                raise ValueError()
            if self.remote_set:
                self.peer.emit("add-ice-candidate", payload["sdpMLineIndex"], payload["candidate"])
            elif len(self.pending_ice) < 32:
                self.pending_ice.append(payload)
            else:
                raise ValueError()
        elif kind == "send-channel":
            self.send_channel(payload)
        elif kind in {"start-media", "renew-media"}:
            if not self.dtls or set(self.channels) != LABELS or any(c.get_property("ready-state") != self.WebRTC.WebRTCDataChannelState.OPEN for c in self.channels.values()):
                raise ValueError()
            if (kind == "start-media") != (self.screen is None):
                raise ValueError()
            self.media.install(payload, received_ns, clock_ns())
            if kind == "start-media":
                self.start_media()
        elif kind in {"stop", "stop-media"}:
            if payload:
                raise ValueError()
            self.fail("SUPERVISOR_STOP")
        else:
            raise ValueError()

    def description_set_callback(self, promise, *_):
        reply = promise.get_reply()
        if reply is not None and reply.has_field("error"):
            self.fail("REMOTE_DESCRIPTION_FAILED")
            return
        self.post(self.description_set)

    def description_set(self):
        self.remote_set = True
        for candidate in self.pending_ice:
            self.peer.emit("add-ice-candidate", candidate["sdpMLineIndex"], candidate["candidate"])
        self.pending_ice.clear()
        self.peer.emit("create-answer", None, self.Gst.Promise.new_with_change_func(self.answer_created_callback, None))

    def answer_created_callback(self, promise, *_):
        reply = promise.get_reply()
        if not reply or not reply.has_field("answer"):
            self.fail("ANSWER_CREATION_FAILED")
            return
        # The promise reply is callback-scoped. Retain a boxed copy before crossing threads.
        self.post(self.answer_created, reply.get_value("answer").copy())

    def answer_created(self, answer):
        self.peer.emit("set-local-description", answer, self.Gst.Promise.new())
        self.send("answer", {"sdp": answer.sdp.as_text()})

    def local_ice(self, index, candidate):
        if candidate == "":  # GStreamer 1.28 end-of-candidates notification.
            return
        if not network_candidate(candidate, self.ice_policy):
            self.fail("INVALID_LOCAL_ICE")
            return
        # Relay policy must not disclose local host/srflx addresses in signaling.
        if self.ice_policy == "relay" and candidate.split()[7] != "relay":
            return
        self.send("ice", {"sdpMLineIndex": index, "candidate": candidate})

    def prepare_channel(self, _peer, channel, is_local):
        if is_local:
            self.fail("INVALID_DATA_CHANNEL")
            return
        # Remote metadata is populated by DCEP after prepare-data-channel.
        # Install listeners now; validate the populated properties at on-open.
        channel.connect("on-open", lambda _c: self.channel(channel))
        channel.connect("on-close", lambda _c: self.fail("DATA_CHANNEL_CLOSED"))
        channel.connect("on-error", lambda *_: self.fail("DATA_CHANNEL_ERROR"))
        channel.connect("on-message-string", lambda _c, raw: self.prepared_message(channel, raw))
        channel.connect("on-message-data", lambda _c, raw: self.prepared_message(channel, raw))

    def channel(self, channel):
        label = channel.get_property("label")
        if (label not in LABELS or label in self.channels or not channel.get_property("ordered")
                or channel.get_property("max-retransmits") != -1 or channel.get_property("max-packet-lifetime") != -1
                or channel.get_property("negotiated") or channel.get_property("protocol") not in {"", None}
                or channel.get_property("ready-state") != self.WebRTC.WebRTCDataChannelState.OPEN):
            self.fail("INVALID_DATA_CHANNEL")
            return
        self.channels[label] = channel
        self.post(self.send, "channel-open", {"label": label})

    def prepared_message(self, channel, raw):
        label = channel.get_property("label")
        if self.channels.get(label) is not channel:
            self.fail("INVALID_DATA_CHANNEL")
            return
        self.queue_channel(label, raw)

    def queue_channel(self, label, raw):
        try:
            if isinstance(raw, str):
                if len(raw) > MAX_CHANNEL_BYTES:
                    raise ValueError()
                data = raw.encode("utf-8")
            else:
                if raw.get_size() > MAX_CHANNEL_BYTES:
                    raise ValueError()
                data = bytes(raw.get_data())
            if not 0 < len(data) <= MAX_CHANNEL_BYTES:
                raise ValueError()
            self.post(self.receive_channel, label, data)
        except Exception:
            self.fail("DATA_CHANNEL_MESSAGE_LIMIT")

    def receive_channel(self, label, data):
        data = data.encode("utf-8") if isinstance(data, str) else data
        if not 0 < len(data) <= MAX_CHANNEL_BYTES:
            self.fail("DATA_CHANNEL_MESSAGE_LIMIT")
            return
        # Rust alone parses/authorizes these bytes. Python never executes their input content.
        self.send("channel-data", {"label": label, "data": base64.urlsafe_b64encode(data).decode().rstrip("=")})

    def send_channel(self, payload):
        if set(payload) != {"label", "data"} or payload["label"] not in self.channels or not isinstance(payload["data"], str) or len(payload["data"]) > 5500:
            raise ValueError()
        data = base64.urlsafe_b64decode(payload["data"] + "=" * (-len(payload["data"]) % 4))
        if base64.urlsafe_b64encode(data).decode().rstrip("=") != payload["data"] or not 0 < len(data) <= MAX_CHANNEL_BYTES:
            raise ValueError()
        channel = self.channels[payload["label"]]
        if channel.get_property("ready-state") != self.WebRTC.WebRTCDataChannelState.OPEN or channel.get_property("buffered-amount") + len(data) > 16384:
            raise ValueError()
        # rc-state-v1's wire format is UTF-8 JSON; binary input acknowledgements are not used.
        channel.emit("send-string", data.decode("utf-8", errors="strict"))

    def observe_dtls(self):
        sctp = self.peer.get_property("sctp-transport")
        if not sctp:
            return
        transport = sctp.get_property("transport")
        if not transport or transport.get_property("state") != self.WebRTC.WebRTCDTLSTransportState.CONNECTED:
            return
        binding = {"hostFingerprint": certificate_fingerprint(transport.get_property("certificate")),
                   "controllerFingerprint": certificate_fingerprint(transport.get_property("remote-certificate"))}
        # Cross-check the media transport as well; max-bundle must not conceal a different peer.
        transceivers = self.peer.emit("get-transceivers")
        if transceivers.len > 2:
            raise ValueError("UNEXPECTED_MEDIA_TRANSPORT")
        for index in range(transceivers.len):
            transceiver = self.peer.emit("get-transceiver", index)
            rtp = transceiver.get_property("sender").get_property("transport")
            if rtp and rtp.get_property("state") == self.WebRTC.WebRTCDTLSTransportState.CONNECTED:
                actual = {"hostFingerprint": certificate_fingerprint(rtp.get_property("certificate")),
                          "controllerFingerprint": certificate_fingerprint(rtp.get_property("remote-certificate"))}
                if actual != binding:
                    raise ValueError("DTLS_BINDING_CHANGED")
        if self.dtls and self.dtls != binding:
            raise ValueError("DTLS_BINDING_CHANGED")
        if not self.dtls:
            self.dtls = binding
            self.send("dtls", binding)

    def tick(self):
        if self.closed.is_set():
            return False
        now = clock_ns()
        if now - self.last_heartbeat >= 3_000_000_000:
            self.fail("SUPERVISOR_TIMEOUT")
        elif self.ice_expires_at is not None and now >= self.ice_expires_at:
            self.fail("ICE_CONFIGURATION_EXPIRED")
        elif self.screen is not None and not self.media.alive(now):
            self.fail("MEDIA_LEASE_EXPIRED")
        else:
            try:
                self.observe_dtls()
                state = self.peer.get_property("connection-state")
                if state in {self.WebRTC.WebRTCPeerConnectionState.FAILED, self.WebRTC.WebRTCPeerConnectionState.DISCONNECTED, self.WebRTC.WebRTCPeerConnectionState.CLOSED}:
                    self.fail("PEER_DISCONNECTED")
                if self.screen is not None:
                    if self.screen.poll() is not None:
                        self.fail("SCREEN_SOURCE_EXITED")
                    else:
                        os.write(self.screen.stdin.fileno(), b"heartbeat\n")
            except Exception:
                self.fail("ENGINE_SUPERVISION_FAILED")
        return not self.closed.is_set()

    def report_progress(self):
        if self.closed.is_set():
            return False
        if self.screen is not None:
            layout = self.layout.snapshot()
            if layout is not None:
                self.send("media-layout", layout)
            self.send("media-progress", self.progress.snapshot())
        return not self.closed.is_set()

    def start_media(self):
        if self.closed.is_set() or not self.media.alive(clock_ns()):
            raise ValueError()
        self.media_started_at_ns = clock_ns()
        self.screen = subprocess.Popen([self.source, *self.source_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, bufsize=0, close_fds=True)
        os.set_blocking(self.screen.stdin.fileno(), False)
        threading.Thread(target=self.read_screen, daemon=True).start()
        self.diagnostics_thread = threading.Thread(target=self.read_diagnostics, daemon=True)
        self.diagnostics_thread.start()
        self.send("media-started", {"screenPid": self.screen.pid})

    def discard_forward_for_test(self, now_ns):
        # A launch-only development fault: drain source output without pushing it.
        # Neither media IPC commands nor data-channel bytes can enable this path.
        if (not self.test_source_faults or self.test_forward_freeze_after_ns is None
                or self.media_started_at_ns is None
                or now_ns < self.media_started_at_ns + self.test_forward_freeze_after_ns):
            return False
        if not self.test_forward_freeze_announced:
            self.test_forward_freeze_announced = True
            self.send("test-fault", {"phase": "begin", "stage": "forwarded"})
        return True

    def read_diagnostics(self):
        try:
            while True:
                raw = self.screen.stderr.readline(4097)
                if not raw:
                    return
                if len(raw) > 4096 or not raw.endswith(b"\n"):
                    raise ValueError()
                message = strict_json(raw)
                if message.get("type") == "error":
                    if message.get("reason") == "MEDIA_LAYOUT_CHANGED":
                        self.send("error", {"reason": "MEDIA_LAYOUT_CHANGED"})
                        self.fail("MEDIA_LAYOUT_CHANGED")
                    else:
                        self.fail("SCREEN_SOURCE_ERROR")
                    return
                if message.get("type") == "screen-source-stopped":
                    self.screen_stats = message
                    if message.get("reason") == "MEDIA_LAYOUT_CHANGED":
                        self.send("error", {"reason": "MEDIA_LAYOUT_CHANGED"})
                        self.fail("MEDIA_LAYOUT_CHANGED")
                        return
                elif message.get("type") == "screen-source-layout":
                    try:
                        self.layout.source(message)
                    except ValueError as error:
                        if str(error) == "MEDIA_LAYOUT_CHANGED":
                            self.send("error", {"reason": "MEDIA_LAYOUT_CHANGED"})
                            self.fail("MEDIA_LAYOUT_CHANGED")
                            return
                        raise
                elif message.get("type") == "screen-source-progress":
                    self.progress.source(message, clock_ns())
                elif message.get("type") == "screen-source-test-fault":
                    if (not self.test_source_faults or set(message) != {"type", "phase", "stage"}
                            or message["phase"] not in {"begin", "end"} or message["stage"] not in {"capture", "encode", "layout"}):
                        raise ValueError("UNEXPECTED_TEST_SOURCE_FAULT")
                    self.send("test-fault", {"phase": message["phase"], "stage": message["stage"]})
        except Exception:
            self.fail("SCREEN_DIAGNOSTICS_FAILED")

    def read_screen(self):
        source = self.pipeline.get_by_name("screen")
        def exact(count):
            data = bytearray()
            while len(data) < count and not self.closed.is_set():
                chunk = self.screen.stdout.read(count - len(data))
                if not chunk:
                    return None
                data.extend(chunk)
            return bytes(data) if len(data) == count else None
        while not self.closed.is_set():
            header = exact(12)
            if header is None:
                break
            size, pts = struct.unpack(">IQ", header)
            if not 0 < size <= MAX_FRAME_BYTES:
                self.fail("SCREEN_FRAME_LIMIT")
                return
            data = exact(size)
            if data is None:
                break
            if not self.media.alive(clock_ns()) or source.get_property("current-level-bytes") + size > MAX_FRAME_BYTES:
                self.fail("SCREEN_BACKPRESSURE_OR_EXPIRED")
                return
            if self.discard_forward_for_test(clock_ns()):
                continue
            frame = self.Gst.Buffer.new_wrapped(data)
            frame.pts = pts
            frame.dts = pts
            frame.duration = self.Gst.SECOND // 15
            if source.emit("push-buffer", frame) != self.Gst.FlowReturn.OK:
                self.fail("SCREEN_PUSH_FAILED")
                return
            try:
                self.progress.forwarded(clock_ns())
            except ValueError:
                self.fail("FORWARD_PROGRESS_INVALID")
                return
            self.frames += 1
            self.bytes += size
        if not self.closed.is_set():
            self.fail("SCREEN_SOURCE_EOF")

    def bus_message(self, _bus, message):
        if message.type in {self.Gst.MessageType.ERROR, self.Gst.MessageType.EOS}:
            self.fail("GSTREAMER_PIPELINE_FAILED")

    def run(self):
        threading.Thread(target=self.read_stdin, daemon=True).start()
        self.pipeline.set_state(self.Gst.State.PLAYING)
        self.send("ready", {"pid": os.getpid(), "version": self.Gst.version_string(), "loopbackOnly": True, "mediaStarted": False})
        try:
            self.loop.run()
        finally:
            self.closed.set()
            self.media.terminal = True
            if self.screen is not None:
                try:
                    self.screen.stdin.close()
                except OSError:
                    pass
                try:
                    self.screen.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    self.screen.kill()
                    self.screen.wait(timeout=1.5)
                if self.diagnostics_thread:
                    self.diagnostics_thread.join(timeout=0.5)
            self.pipeline.set_state(self.Gst.State.NULL)
            print(f"host-engine stopped: {self.reason}", file=sys.stderr, flush=True)
            self.send("stopped", {"reason": self.reason, "frames": self.frames, "bytes": self.bytes,
                                  "screenPid": self.screen.pid if self.screen else None,
                                  "screenExitCode": self.screen.returncode if self.screen else None,
                                  "screenStopReason": self.screen_stats.get("reason") if self.screen_stats else None,
                                  "captureStopped": self.screen is None or bool(self.screen_stats and self.screen_stats.get("captureStopped")),
                                  "childExited": self.screen is None or self.screen.poll() is not None})


def read_bootstrap():
    """Shared bounded stdin-only bootstrap for both fixed bundle and test CLI."""
    bootstrap = bytearray()
    deadline = time.monotonic() + 5
    while b"\n" not in bootstrap and time.monotonic() < deadline:
        if select.select([sys.stdin.fileno()], [], [], max(0, deadline - time.monotonic()))[0]:
            value = os.read(sys.stdin.fileno(), 1)
            if not value:
                raise ValueError("BOOTSTRAP_EOF")
            bootstrap.extend(value)
            if len(bootstrap) > 2048:
                raise ValueError("BOOTSTRAP_LIMIT")
    if not bootstrap.endswith(b"\n"):
        raise ValueError("BOOTSTRAP_TIMEOUT")
    return HostIpc.accept_bootstrap(bytes(bootstrap))


def supervise_engine(instance):
    signal.signal(signal.SIGTERM, lambda *_: instance.fail("TERMINATED"))
    signal.signal(signal.SIGINT, lambda *_: instance.fail("TERMINATED"))
    instance.run()


def main():
    faulthandler.enable(file=sys.stderr)
    parser = argparse.ArgumentParser()
    parser.add_argument("--screen-source", required=True)
    parser.add_argument("--test-source-faults", action="store_true")
    parser.add_argument("--source-arg", action="append", default=[])
    parser.add_argument("--test-forward-freeze-after-ms", type=int)
    args = parser.parse_args()
    if (args.source_arg or args.test_forward_freeze_after_ms is not None) and not args.test_source_faults:
        parser.error("source arguments require the explicit development-only --test-source-faults flag")
    if args.test_forward_freeze_after_ms is not None and not 0 <= args.test_forward_freeze_after_ms <= 40_000:
        parser.error("test forward freeze must be within 0..40000 ms")
    source = Path(args.screen_source)
    if not source.is_absolute() or not source.is_file() or not os.access(source, os.X_OK):
        parser.error("requires a fixed existing absolute native source executable")
    codec = read_bootstrap()
    with tempfile.TemporaryDirectory(prefix="todesk-host-engine-") as directory:
        engine = Engine(codec, str(source), load_sdk(str(Path(directory) / "registry.bin")),
                        source_args=args.source_arg, test_source_faults=args.test_source_faults,
                        test_forward_freeze_after_ms=args.test_forward_freeze_after_ms)
        supervise_engine(engine)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Do not print keys, SDP, raw channel messages or screen contents.
        print("host-engine failed before orderly shutdown", file=sys.stderr)
        sys.exit(1)
