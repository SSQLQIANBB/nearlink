"""Standard-library safety checks; the separate loopback harness tests real media."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import struct
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location("host_engine", Path(__file__).with_name("remote-control-host-engine.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class EngineContractTests(unittest.TestCase):
    def test_live_engine_survives_sixty_seconds_with_continuously_renewed_leases(self):
        instance = object.__new__(engine.Engine)
        instance.closed = threading.Event()
        instance.started_at = 0  # Reproduce the former absolute developer timer.
        instance.ice_expires_at = 3_600_000_000_000
        instance.media = engine.MediaDeadline()
        instance.screen = SimpleNamespace(poll=lambda: None, stdin=SimpleNamespace(fileno=lambda: 9))
        instance.WebRTC = SimpleNamespace(WebRTCPeerConnectionState=SimpleNamespace(FAILED=1, DISCONNECTED=2, CLOSED=3))
        instance.peer = SimpleNamespace(get_property=lambda _: 0)
        instance.observe_dtls = lambda: None
        failures = []
        def fail(reason):
            failures.append(reason)
            instance.closed.set()
        instance.fail = fail
        for second in range(0, 1801):
            now = second * 1_000_000_000
            instance.last_heartbeat = now
            if second % 5 == 0:
                instance.media.install({"mediaLeaseSeq": second // 5 + 1, "ttlMs": 15000,
                    "monotonicDeadlineNs": str(now + 15_000_000_000)}, now, now)
            with patch.object(engine, "clock_ns", return_value=now), patch.object(engine.os, "write"):
                self.assertTrue(instance.tick(), (second, failures))
        self.assertEqual(failures, [])
        # Removing the development timer must not disable existing safety stops.
        for reason in ["SUPERVISOR_TIMEOUT", "ICE_CONFIGURATION_EXPIRED", "MEDIA_LEASE_EXPIRED"]:
            instance.closed.clear()
            instance.last_heartbeat = now
            instance.ice_expires_at = now + 100_000_000_000
            instance.media.deadline = now + 15_000_000_000
            if reason == "SUPERVISOR_TIMEOUT": instance.last_heartbeat = now - 3_000_000_000
            elif reason == "ICE_CONFIGURATION_EXPIRED": instance.ice_expires_at = now
            else: instance.media.deadline = now
            with patch.object(engine, "clock_ns", return_value=now), patch.object(engine.os, "write"):
                self.assertFalse(instance.tick())
            self.assertEqual(failures[-1], reason)

    @staticmethod
    def layout_message():
        return {"type": "screen-source-layout", "screenId": "primary", "layoutVersion": 1, "geometry": {
            "displayId": 2, "coordinateSpace": "quartz-global-logical",
            "displayBounds": {"x": 0, "y": 0, "width": 1920, "height": 1080},
            "displayPixels": {"width": 3840, "height": 2160}, "rotationDegrees": 0,
            "encodedSize": {"width": 1280, "height": 720},
            "contentRect": {"x": 160, "y": 90, "width": 960, "height": 540}}}

    def test_layout_preserves_real_letterbox_geometry_and_repeats_immutable_snapshots(self):
        tracker = engine.MediaLayoutTracker()
        self.assertIsNone(tracker.snapshot())
        message = self.layout_message()
        tracker.source(message)
        snapshot = tracker.snapshot()
        tracker.source(copy.deepcopy(message))
        self.assertEqual(tracker.snapshot(), snapshot)
        self.assertEqual(snapshot["geometry"]["contentRect"], {"x": 160, "y": 90, "width": 960, "height": 540})
        message["geometry"]["contentRect"]["x"] = 0
        snapshot["geometry"]["displayPixels"]["width"] = 1
        self.assertEqual(tracker.snapshot()["geometry"]["displayPixels"]["width"], 3840)
        self.assertEqual(tracker.snapshot()["geometry"]["contentRect"]["x"], 160)

    def test_layout_rejects_changes_without_replacing_the_previous_authoritative_snapshot(self):
        tracker = engine.MediaLayoutTracker()
        tracker.source(self.layout_message())
        previous = tracker.snapshot()
        for path, value in [(('layoutVersion',), 2), (('geometry', 'displayId'), 3),
                            (('geometry', 'rotationDegrees'), 90), (('geometry', 'displayPixels', 'width'), 3838),
                            (('geometry', 'contentRect', 'x'), 159.5), (('geometry', 'encodedSize', 'width'), 1282),
                            (('geometry', 'displayBounds', 'x'), -100)]:
            message = self.layout_message()
            target = message
            for key in path[:-1]: target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'MEDIA_LAYOUT_CHANGED'):
                tracker.source(message)
            self.assertEqual(tracker.snapshot(), previous)

    def test_layout_strictly_rejects_unknown_nonfinite_out_of_range_or_outside_content(self):
        invalid = [
            (('accepted',), True), (('type',), 'media-layout'), (('screenId',), 'other'),
            (('layoutVersion',), True), (('layoutVersion',), 0), (('layoutVersion',), engine.MAX_SAFE_SEQUENCE + 1),
            (('geometry', 'unknown'), 0), (('geometry', 'displayId'), 0), (('geometry', 'displayId'), 1 << 32),
            (('geometry', 'coordinateSpace'), 'pixels'), (('geometry', 'rotationDegrees'), 45),
            (('geometry', 'displayPixels', 'width'), 0), (('geometry', 'displayPixels', 'width'), 16385),
            (('geometry', 'encodedSize', 'height'), 720.5), (('geometry', 'contentRect', 'x'), -0.5),
            (('geometry', 'contentRect', 'width'), 1200), (('geometry', 'contentRect', 'height'), 0),
            (('geometry', 'displayBounds', 'x'), float('nan')), (('geometry', 'displayBounds', 'y'), float('inf')),
            (('geometry', 'displayBounds', 'width'), True), (('geometry', 'contentRect', 'x'), '160'),
            (('geometry', 'displayBounds', 'width'), 0.5), (('geometry', 'displayBounds', 'x'), 1_000_001),
        ]
        for path, value in invalid:
            message = self.layout_message()
            target = message
            for key in path[:-1]: target = target[key]
            target[path[-1]] = value
            tracker = engine.MediaLayoutTracker()
            with self.subTest(path=path, value=value), self.assertRaises(ValueError): tracker.source(message)
            self.assertIsNone(tracker.snapshot())

    def test_diagnostics_layout_change_stops_without_forwarding_untrusted_replacement(self):
        messages = [self.layout_message(), self.layout_message()]
        messages[1]['geometry']['displayPixels']['width'] += 2
        instance = object.__new__(engine.Engine)
        instance.layout = engine.MediaLayoutTracker()
        instance.screen = SimpleNamespace(stderr=io.BytesIO(('\n'.join(json.dumps(message) for message in messages) + '\n').encode()))
        failures, sent = [], []
        instance.fail = failures.append
        instance.send = lambda *args: sent.append(args)
        instance.read_diagnostics()
        self.assertEqual(instance.layout.snapshot()['geometry']['displayPixels']['width'], 3840)
        self.assertEqual(sent, [('error', {'reason': 'MEDIA_LAYOUT_CHANGED'})])
        self.assertEqual(failures, ['MEDIA_LAYOUT_CHANGED'])

    def test_diagnostics_reject_duplicate_nested_layout_fields_and_partial_lines(self):
        valid = json.dumps(self.layout_message()).encode()
        invalid = [valid.replace(b'"displayId": 2', b'"displayId": 2, "displayId": 3') + b'\n',
                   valid.replace(b'"rotationDegrees": 0', b'"rotationDegrees": NaN') + b'\n', valid]
        for raw in invalid:
            instance = object.__new__(engine.Engine)
            instance.layout = engine.MediaLayoutTracker()
            instance.screen = SimpleNamespace(stderr=io.BytesIO(raw))
            failures = []
            instance.fail = failures.append
            instance.send = lambda *_: self.fail('invalid diagnostics escaped')
            instance.read_diagnostics()
            self.assertEqual(failures, ['SCREEN_DIAGNOSTICS_FAILED'])
            self.assertIsNone(instance.layout.snapshot())

    def test_only_fixed_source_layout_change_reason_is_preserved(self):
        for message, expected in [({'type': 'screen-source-stopped', 'reason': 'MEDIA_LAYOUT_CHANGED'}, 'MEDIA_LAYOUT_CHANGED'),
                                  ({'type': 'error', 'reason': 'MEDIA_LAYOUT_CHANGED'}, 'MEDIA_LAYOUT_CHANGED'),
                                  ({'type': 'error', 'reason': 'arbitrary-user-value'}, 'SCREEN_SOURCE_ERROR')]:
            instance = object.__new__(engine.Engine)
            instance.screen = SimpleNamespace(stderr=io.BytesIO((json.dumps(message) + '\n').encode()))
            failures, sent = [], []
            instance.fail = failures.append
            instance.send = lambda *args: sent.append(args)
            instance.read_diagnostics()
            self.assertEqual(failures, [expected])
            self.assertEqual(sent, [('error', {'reason': 'MEDIA_LAYOUT_CHANGED'})] if expected == 'MEDIA_LAYOUT_CHANGED' else [])

    @staticmethod
    def progress_message(capture=0, captured="0", encoded=0, encoded_at="0"):
        return {"type": "screen-source-progress", "captureSeq": capture, "captureMonotonicNs": captured,
                "encodedSeq": encoded, "encodedMonotonicNs": encoded_at}

    def test_progress_stages_are_independent_and_duplicate_reports_do_not_refresh_event_times(self):
        progress = engine.MediaProgressTracker()
        self.assertEqual(progress.snapshot(), {"captureSeq": 0, "captureMonotonicNs": "0", "encodedSeq": 0,
                         "encodedMonotonicNs": "0", "forwardedSeq": 0, "forwardedMonotonicNs": "0"})
        progress.source(self.progress_message(1, "100", 1, "101"), 200)
        progress.forwarded(201)
        progress.source(self.progress_message(1, "100", 2, "202"), 500)
        progress.forwarded(501)
        snapshot = progress.snapshot()
        progress.source(self.progress_message(1, "100", 2, "202"), 10_000)
        self.assertEqual(progress.snapshot(), snapshot)
        self.assertEqual(snapshot, {"captureSeq": 1, "captureMonotonicNs": "100", "encodedSeq": 2,
                         "encodedMonotonicNs": "202", "forwardedSeq": 2, "forwardedMonotonicNs": "501"})

    def test_progress_rejects_noncanonical_future_regressing_and_retimed_events_atomically(self):
        progress = engine.MediaProgressTracker()
        progress.source(self.progress_message(2, "100", 3, "110"), 200)
        prior = progress.snapshot()
        for seq, observed in [(True, "150"), (-1, "150"), (engine.MAX_SAFE_SEQUENCE + 1, "150"),
                              (3, "0150"), (3, "+150"), (3, "150.0"), (3, 150), (0, "100"),
                              (3, "0"), (3, str(engine.MAX_U64 + 1)), (3, "201"),
                              (1, "150"), (2, "101"), (3, "100")]:
            with self.subTest(seq=seq, observed=observed), self.assertRaises(ValueError):
                progress.source(self.progress_message(seq, observed, 4, "180"), 200)
            self.assertEqual(progress.snapshot(), prior)
        with self.assertRaises(ValueError):
            progress.source(self.progress_message(3, "150", 4, "110"), 200)
        self.assertEqual(progress.snapshot(), prior, "failed second-stage validation must not partially commit capture")

    def test_progress_schema_and_forwarded_overflow_fail_closed(self):
        for message in [{}, {**self.progress_message(), "accepted": True},
                        {**self.progress_message(), "type": "other"}]:
            with self.assertRaises(ValueError):
                engine.MediaProgressTracker().source(message, 100)
        progress = engine.MediaProgressTracker()
        for invalid in [0, -1, engine.MAX_U64 + 1]:
            with self.assertRaises(ValueError):
                progress.forwarded(invalid)
        progress.forwarded(100)
        with self.assertRaises(ValueError):
            progress.forwarded(100)
        progress.stages["forwarded"] = engine.MAX_SAFE_SEQUENCE, 100
        with self.assertRaises(ValueError):
            progress.forwarded(101)

    def test_diagnostics_preserve_source_time_and_test_fault_requires_explicit_launch_mode(self):
        source_report = self.progress_message(1, "100", 1, "110")
        fault = {"type": "screen-source-test-fault", "phase": "begin", "stage": "capture"}
        for enabled in [False, True]:
            instance = object.__new__(engine.Engine)
            instance.progress = engine.MediaProgressTracker()
            instance.test_source_faults = enabled
            instance.screen = SimpleNamespace(stderr=io.BytesIO((json.dumps(source_report) + "\n" + json.dumps(fault) + "\n").encode()))
            failures, sent = [], []
            instance.fail = failures.append
            instance.send = lambda *args: sent.append(args)
            with patch.object(engine, "clock_ns", return_value=100_000):
                instance.read_diagnostics()
            self.assertEqual(instance.progress.snapshot()["captureMonotonicNs"], "100")
            self.assertEqual(failures, [] if enabled else ["SCREEN_DIAGNOSTICS_FAILED"])
            self.assertEqual(sent, [("test-fault", {"phase": "begin", "stage": "capture"})] if enabled else [])

    def test_periodic_progress_is_cumulative_and_only_reported_after_source_started(self):
        instance = object.__new__(engine.Engine)
        instance.closed = threading.Event()
        instance.progress = engine.MediaProgressTracker()
        instance.layout = engine.MediaLayoutTracker()
        instance.screen = None
        sent = []
        instance.send = lambda *args: sent.append(args)
        self.assertTrue(instance.report_progress())
        self.assertEqual(sent, [])
        instance.screen = object()
        instance.progress.source(self.progress_message(1, "100"), 200)
        self.assertTrue(instance.report_progress())
        self.assertTrue(instance.report_progress())
        self.assertEqual(sent[0], sent[1])
        self.assertEqual(sent[0][0], "media-progress")
        instance.closed.set()
        self.assertFalse(instance.report_progress())
        self.assertEqual(len(sent), 2)

    def test_valid_layout_is_repeated_before_progress_but_unknown_layout_is_not_invented(self):
        instance = object.__new__(engine.Engine)
        instance.closed = threading.Event()
        instance.progress = engine.MediaProgressTracker()
        instance.layout = engine.MediaLayoutTracker()
        instance.screen = object()
        sent = []
        instance.send = lambda *args: sent.append(args)
        instance.report_progress()
        self.assertEqual([kind for kind, _ in sent], ['media-progress'])
        instance.layout.source(self.layout_message())
        instance.report_progress()
        instance.report_progress()
        self.assertEqual([kind for kind, _ in sent], ['media-progress', 'media-layout', 'media-progress', 'media-layout', 'media-progress'])
        self.assertEqual(sent[1], sent[3])

    def test_forward_progress_requires_a_successful_gstreamer_push(self):
        for succeeds in [False, True]:
            instance = object.__new__(engine.Engine)
            instance.closed = threading.Event()
            instance.progress = engine.MediaProgressTracker()
            instance.media = SimpleNamespace(alive=lambda _: True)
            instance.test_source_faults = False
            instance.frames, instance.bytes = 0, 0
            failures, pushed = [], []
            frame_bytes = b"\x00\x00\x00\x01frame"
            instance.screen = SimpleNamespace(stdout=io.BytesIO(struct.pack(">IQ", len(frame_bytes), 123) + frame_bytes))
            def push(_signal, frame):
                pushed.append(frame)
                return "ok" if succeeds else "failed"
            source = SimpleNamespace(get_property=lambda _: 0, emit=push)
            instance.pipeline = SimpleNamespace(get_by_name=lambda _: source)
            instance.Gst = SimpleNamespace(Buffer=SimpleNamespace(new_wrapped=lambda data: SimpleNamespace(data=data)),
                                           FlowReturn=SimpleNamespace(OK="ok"), SECOND=1_000_000_000)
            instance.fail = failures.append
            with patch.object(engine, "clock_ns", return_value=200):
                instance.read_screen()
            self.assertEqual(len(pushed), 1)
            self.assertEqual(pushed[0].data, frame_bytes)
            self.assertEqual(instance.progress.snapshot()["forwardedSeq"], 1 if succeeds else 0)
            self.assertEqual(instance.progress.snapshot()["forwardedMonotonicNs"], "200" if succeeds else "0")
            self.assertEqual(instance.progress.snapshot()["captureSeq"], 0)
            self.assertEqual(instance.progress.snapshot()["encodedSeq"], 0)
            self.assertEqual(failures, ["SCREEN_SOURCE_EOF"] if succeeds else ["SCREEN_PUSH_FAILED"])

    def test_source_flags_cannot_be_enabled_without_explicit_test_launch(self):
        with self.assertRaisesRegex(ValueError, "TEST_SOURCE_ARGUMENTS_DISABLED"):
            engine.Engine(None, "/fixed-source", (), source_args=["--test-freeze-stage", "capture"])
        with self.assertRaisesRegex(ValueError, "TEST_SOURCE_ARGUMENTS_DISABLED"):
            engine.Engine(None, "/fixed-source", (), test_forward_freeze_after_ms=2500)
        for invalid in [True, -1, 40_001]:
            with self.assertRaisesRegex(ValueError, "INVALID_TEST_FORWARD_FREEZE"):
                engine.Engine(None, "/fixed-source", (), test_source_faults=True, test_forward_freeze_after_ms=invalid)

    def test_cli_rejects_fault_flags_before_bootstrap_or_source_execution(self):
        script = str(Path(__file__).with_name("remote-control-host-engine.py"))
        for flags in [["--test-forward-freeze-after-ms", "2500"], ["--source-arg=--test-freeze-stage"],
                      ["--test-source-faults", "--test-forward-freeze-after-ms", "40001"]]:
            result = subprocess.run([sys.executable, script, "--screen-source=/bin/true", *flags],
                                    input=b"", capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")
            self.assertIn(b"error:", result.stderr)

    def test_forward_fault_drains_source_without_pushing_or_fabricating_forward_progress(self):
        instance = object.__new__(engine.Engine)
        instance.closed = threading.Event()
        instance.progress = engine.MediaProgressTracker()
        instance.progress.source(self.progress_message(10, "90", 10, "95"), 100)
        instance.progress.forwarded(100)
        instance.media = SimpleNamespace(alive=lambda _: True)
        instance.test_source_faults = True
        instance.test_forward_freeze_after_ns = 20
        instance.media_started_at_ns = 100
        instance.test_forward_freeze_announced = False
        instance.frames, instance.bytes = 0, 0
        failures, sent = [], []
        record = struct.pack(">IQ", 5, 123) + b"frame"
        instance.screen = SimpleNamespace(stdout=io.BytesIO(record * 3))
        source = SimpleNamespace(get_property=lambda _: 0, emit=lambda *_: self.fail("frozen stage pushed a frame"))
        instance.pipeline = SimpleNamespace(get_by_name=lambda _: source)
        instance.fail = failures.append
        instance.send = lambda *args: sent.append(args)
        self.assertFalse(instance.discard_forward_for_test(119))
        with patch.object(engine, "clock_ns", return_value=120):
            instance.read_screen()
        self.assertEqual(instance.screen.stdout.tell(), len(record) * 3)
        self.assertEqual(instance.progress.snapshot()["forwardedSeq"], 1)
        self.assertEqual(instance.progress.snapshot()["forwardedMonotonicNs"], "100")
        self.assertEqual(instance.progress.snapshot()["captureSeq"], 10)
        self.assertEqual(sent, [("test-fault", {"phase": "begin", "stage": "forwarded"})])
        self.assertEqual(failures, ["SCREEN_SOURCE_EOF"])

    def test_line_framing_accepts_a_maximum_line_and_next_frame_in_the_same_read(self):
        framer = engine.IpcLineFramer()
        prefix = b"x" * (engine.MAX_LINE_BYTES - 2)
        self.assertEqual(framer.feed(prefix), [])
        self.assertEqual(framer.feed(b"x\nnext\npartial"), [prefix + b"x\n", b"next\n"])
        self.assertEqual(framer.feed(b"-tail\n"), [b"partial-tail\n"])

    def test_line_framing_rejects_oversized_complete_or_incomplete_individual_lines(self):
        for chunk in [b"x" * engine.MAX_LINE_BYTES + b"\n", b"x" * (engine.MAX_LINE_BYTES + 1),
                      b"valid\n" + b"x" * engine.MAX_LINE_BYTES + b"\n"]:
            with self.assertRaisesRegex(ValueError, "IPC_LINE_LIMIT"):
                engine.IpcLineFramer().feed(chunk)

    def test_fingerprint_hashes_certificate_der_instead_of_sdp_claim(self):
        der = bytes(range(64))
        pem = ssl.DER_cert_to_PEM_cert(der)
        self.assertEqual(engine.certificate_fingerprint(pem), hashlib.sha256(der).hexdigest().upper())
        for invalid in [None, "a=fingerprint:sha-256 AB:CD", "-----BEGIN CERTIFICATE-----\n!invalid\n-----END CERTIFICATE-----"]:
            with self.assertRaises(ValueError):
                engine.certificate_fingerprint(invalid)

    def test_turn_uris_escape_timestamp_username_and_base64_password(self):
        config = {"iceServers": [{"urls": ["stun:turn.example.com:3478"]},
                                  {"urls": ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"],
                                   "username": "1700000000:rc:opaque", "credential": "test+/="}],
                  "iceTransportPolicy": "all", "expiresAt": 60000}
        stun, turns = engine.ice_configuration(config, 0)
        self.assertEqual(stun, "stun://turn.example.com:3478")
        self.assertEqual(turns, ["turn://1700000000%3Arc%3Aopaque:test%2B%2F%3D@turn.example.com:3478?transport=udp",
                                 "turns://1700000000%3Arc%3Aopaque:test%2B%2F%3D@turn.example.com:5349?transport=tcp"])
        for field, value in [('expiresAt', 0), ('expiresAt', True), ('expiresAt', 3_900_001), ('iceTransportPolicy', 'auto'), ('iceServers', [])]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                engine.ice_configuration({**config, field: value}, 0)
        for url in ['turn:user:pass@host:3478?transport=udp', 'turns:host:5349?transport=udp', 'turn:bad..host:3478?transport=tcp', 'turn:host:0?transport=tcp', 'https://host:443']:
            invalid = {**config, 'iceServers': [{'urls': [url], 'username': 'test', 'credential': 'test'}]}
            with self.subTest(url=url), self.assertRaises(ValueError): engine.ice_configuration(invalid, 0)

    def test_network_configuration_is_once_before_offer_and_does_not_start_media(self):
        payload = {"iceServers": [{"urls": ["turn:turn.example.com:3478?transport=udp"], "username": "test:user", "credential": "test+/="}],
                   "iceTransportPolicy": "relay", "expiresAt": 60000}
        instance = object.__new__(engine.Engine)
        instance.offer_received = False
        instance.ice_policy = "loopback"
        instance.ice_expires_at = None
        calls, sent = [], []
        instance.peer = SimpleNamespace(set_property=lambda *args: calls.append(args), emit=lambda *args: calls.append(args) or True)
        instance.WebRTC = SimpleNamespace(WebRTCICETransportPolicy=SimpleNamespace(ALL=0, RELAY=1))
        instance.send = lambda *args: sent.append(args)
        instance.start_media = lambda: self.fail('ICE config started capture')
        with patch.object(engine.time, 'time_ns', return_value=0), patch.object(engine, 'clock_ns', return_value=100):
            instance.command({'kind': 'configure-ice', 'payload': payload}, 100)
        self.assertEqual(instance.ice_policy, 'relay')
        self.assertEqual(instance.ice_expires_at, 60_000_000_100)
        self.assertEqual(calls[0], ('ice-transport-policy', 1))
        self.assertEqual(sent, [('network-configured', {'iceTransportPolicy': 'relay'})])
        self.assertNotIn('test:user', str(sent))
        with self.assertRaises(ValueError): instance.command({'kind': 'configure-ice', 'payload': payload}, 100)
        instance.ice_policy = 'loopback'; instance.offer_received = True
        with self.assertRaises(ValueError): instance.command({'kind': 'configure-ice', 'payload': payload}, 100)

    def test_network_candidate_policy_keeps_loopback_default_and_filters_relay_signaling(self):
        candidate = 'candidate:1 1 udp 123 203.0.113.9 44000 typ relay raddr 0.0.0.0 rport 0'
        self.assertTrue(engine.network_candidate(candidate, 'relay'))
        self.assertFalse(engine.network_candidate(candidate))
        host = 'candidate:1 1 udp 123 192.168.1.2 5000 typ host'
        self.assertTrue(engine.network_candidate(host, 'all'))
        for invalid in [candidate + '\r\n', candidate.replace('203.0.113.9', '0.0.0.0'), candidate.replace('203.0.113.9', 'test.local'), candidate + ' raddr', candidate.replace('44000', '65536')]:
            self.assertFalse(engine.network_candidate(invalid, 'all'))
        instance = object.__new__(engine.Engine)
        instance.ice_policy = 'relay'
        sent = []
        instance.send = lambda *args: sent.append(args)
        instance.fail = lambda _: self.fail('unexpected rejection')
        instance.local_ice(0, host)
        self.assertEqual(sent, [])
        instance.local_ice(0, candidate)
        self.assertEqual(sent, [('ice', {'sdpMLineIndex': 0, 'candidate': candidate})])

    def test_only_bounded_loopback_host_ice_is_accepted(self):
        self.assertTrue(engine.loopback_candidate("candidate:1 1 udp 123 127.0.0.1 50000 typ host"))
        self.assertTrue(engine.loopback_candidate("candidate:1 1 udp 123 ::1 50000 typ host"))
        for address in ["192.168.0.2", "example.local", "8.8.8.8"]:
            self.assertFalse(engine.loopback_candidate(f"candidate:1 1 udp 123 {address} 50000 typ host"))
        for invalid in ["candidate:1 1 udp 123 127.0.0.1 50000 typ relay", "candidate:1 1 udp 123 127.0.0.1 0 typ host",
                        "candidate:1 1 udp 123 127.0.0.1 50000 typ host raddr 8.8.8.8", "x" * 4097]:
            self.assertFalse(engine.loopback_candidate(invalid))

    def test_codec_selection_is_video_scoped_and_checks_embedded_ice(self):
        sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 103\r\na=recvonly\r\na=rtpmap:103 H264/90000\r\na=fmtp:103 packetization-mode=1;profile-level-id=42e01f\r\n"
        self.assertEqual(engine.h264_payload(sdp), 103)
        for invalid in [sdp.replace("42e01f", "42001f"), sdp.replace("42e01f", "64001f"), sdp + "m=video 9 UDP/TLS/RTP/SAVPF 103\r\n", sdp + "m=audio 9 RTP/AVP 0\r\n",
                        sdp + "a=candidate:1 1 udp 123 8.8.8.8 50000 typ host\r\n", "x" * 65537]:
            with self.assertRaises(ValueError):
                engine.h264_payload(invalid)

    def test_media_deadline_accounts_for_ipc_queue_delay_and_absolute_deadline(self):
        lease = engine.MediaDeadline()
        lease.install({"mediaLeaseSeq": 1, "ttlMs": 15000, "monotonicDeadlineNs": "10000000000"}, 0, 1_000_000_000)
        self.assertEqual(lease.deadline, 10_000_000_000)
        self.assertTrue(lease.alive(9_999_999_999))
        self.assertFalse(lease.alive(10_000_000_000))
        with self.assertRaises(ValueError):
            lease.install({"mediaLeaseSeq": 2, "ttlMs": 15000, "monotonicDeadlineNs": "30000000000"}, 10_000_000_000, 10_000_000_000)
        self.assertTrue(lease.terminal)

    def test_delayed_first_start_cannot_reset_a_parent_deadline(self):
        lease = engine.MediaDeadline()
        with self.assertRaises(ValueError):
            lease.install({"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000"}, 0, 1_000_000_000)
        self.assertTrue(lease.terminal)

    def test_media_seq_ttl_and_unknown_fields_fail_closed(self):
        for invalid in [{"mediaLeaseSeq": True, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000"},
                        {"mediaLeaseSeq": 1, "ttlMs": 15001, "monotonicDeadlineNs": "9000000000"},
                        {"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "-1"},
                        {"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000", "accepted": True}]:
            with self.assertRaises(ValueError):
                engine.MediaDeadline().install(invalid, 0, 0)
        lease = engine.MediaDeadline()
        payload = {"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000"}
        lease.install(payload, 0, 0)
        with self.assertRaises(ValueError):
            lease.install(payload, 1, 1)

    def test_prepare_channel_receives_immediate_hello_before_work_queue_runs(self):
        instance = object.__new__(engine.Engine)
        instance.channels = {}
        instance.WebRTC = SimpleNamespace(WebRTCDataChannelState=SimpleNamespace(OPEN="open"))
        posted, sent, failures, callbacks = [], [], [], {}
        instance.post = lambda *args: posted.append(args)
        instance.send = lambda *args: sent.append(args)
        instance.fail = failures.append
        properties = {"label": None, "ordered": True, "max-retransmits": -1,
                      "max-packet-lifetime": -1, "negotiated": False, "protocol": "",
                      "ready-state": "connecting"}
        channel = SimpleNamespace(get_property=properties.get,
                                  connect=lambda signal, callback: callbacks.update({signal: callback}))
        instance.prepare_channel(None, channel, False)
        # DCEP fills metadata only after prepare, before on-open.
        self.assertEqual(failures, [])
        self.assertEqual(instance.channels, {})
        properties.update({"label": "rc-state-v1", "ready-state": "open"})
        # GStreamer emits these immediately, before the GLib drain callback.
        callbacks["on-open"](channel)
        hello = '{"type":"hello","proofSignature":"test-only"}'
        callbacks["on-message-string"](channel, hello)
        self.assertEqual(sent, [])
        for callback, *args in posted:
            callback(*args)
        self.assertEqual(failures, [])
        self.assertEqual(sent, [("channel-open", {"label": "rc-state-v1"}),
                               ("channel-data", {"label": "rc-state-v1", "data":
                                base64.urlsafe_b64encode(hello.encode()).decode().rstrip("=")})])
        callbacks["on-open"](channel)
        instance.prepare_channel(None, channel, True)
        unknown = SimpleNamespace(get_property=properties.get)
        instance.prepared_message(unknown, hello)
        self.assertEqual(failures, ["INVALID_DATA_CHANNEL"] * 3)

    def test_open_rejects_invalid_dcep_metadata_before_forwarding(self):
        valid = {"label": "rc-state-v1", "ordered": True, "max-retransmits": -1,
                 "max-packet-lifetime": -1, "negotiated": False, "protocol": "",
                 "ready-state": "open"}
        for field, value in [("label", "unknown"), ("ordered", False), ("max-retransmits", 0),
                             ("max-packet-lifetime", 100), ("negotiated", True),
                             ("protocol", "other"), ("ready-state", "connecting")]:
            with self.subTest(field=field):
                instance = object.__new__(engine.Engine)
                instance.channels = {}
                instance.WebRTC = SimpleNamespace(WebRTCDataChannelState=SimpleNamespace(OPEN="open"))
                failures, posted = [], []
                instance.fail = failures.append
                instance.post = lambda *args: posted.append(args)
                properties = dict(valid, **{field: value})
                instance.channel(SimpleNamespace(get_property=properties.get))
                self.assertEqual(failures, ["INVALID_DATA_CHANNEL"])
                self.assertEqual(instance.channels, {})
                self.assertEqual(posted, [])

    def test_oversized_raw_data_is_rejected_before_entering_the_work_queue(self):
        instance = object.__new__(engine.Engine)
        failures, posted = [], []
        instance.fail = failures.append
        instance.post = lambda *args: posted.append(args)
        instance.queue_channel("rc-input-v1", "x" * 4097)
        instance.queue_channel("rc-state-v1", "界" * 2000)
        self.assertEqual(failures, ["DATA_CHANNEL_MESSAGE_LIMIT"] * 2)
        self.assertEqual(posted, [])
        instance.queue_channel("rc-input-v1", '{"type":"key","code":"KeyA"}')
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0][2], b'{"type":"key","code":"KeyA"}')

    def test_channel_bytes_are_forwarded_unchanged_without_input_interpretation(self):
        instance = object.__new__(engine.Engine)
        sent = []
        instance.send = lambda *args: sent.append(args)
        instance.fail = lambda _: self.fail("unexpected error")
        raw = b'{"accepted":true,"type":"key","code":"KeyA"}'
        instance.receive_channel("rc-input-v1", raw)
        self.assertEqual(sent, [("channel-data", {"label": "rc-input-v1", "data": base64.urlsafe_b64encode(raw).decode().rstrip("=")})])

    def test_start_needs_actual_dtls_and_both_open_reliable_channels(self):
        instance = object.__new__(engine.Engine)
        instance.dtls = None
        instance.channels = {}
        instance.WebRTC = SimpleNamespace(WebRTCDataChannelState=SimpleNamespace(OPEN="open"))
        payload = {"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000"}
        with self.assertRaises(ValueError):
            instance.command({"kind": "start-media", "payload": payload}, 0)
        instance.dtls = {"hostFingerprint": "AB" * 32, "controllerFingerprint": "CD" * 32}
        instance.channels = {"rc-state-v1": SimpleNamespace(get_property=lambda _: "open")}
        with self.assertRaises(ValueError):
            instance.command({"kind": "start-media", "payload": payload}, 0)
        instance.channels["rc-input-v1"] = SimpleNamespace(get_property=lambda _: "connecting")
        with self.assertRaises(ValueError):
            instance.command({"kind": "start-media", "payload": payload}, 0)

    def test_ipc_commands_cannot_override_the_fixed_executable_or_execute_input(self):
        instance = object.__new__(engine.Engine)
        instance.dtls = {"hostFingerprint": "AB" * 32, "controllerFingerprint": "CD" * 32}
        instance.channels = {label: SimpleNamespace(get_property=lambda _: "open") for label in engine.LABELS}
        instance.WebRTC = SimpleNamespace(WebRTCDataChannelState=SimpleNamespace(OPEN="open"))
        instance.media, instance.screen = engine.MediaDeadline(), None
        instance.start_media = lambda: self.fail("Untrusted executable request started media")
        for message in [
            {"kind": "start-media", "payload": {"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000", "screenSource": "/bin/sh"}},
            {"kind": "exec", "payload": {"command": "whoami"}},
            {"kind": "input", "payload": {"accepted": True, "code": "KeyA"}},
            {"kind": "test-source-faults", "payload": {"stage": "forwarded", "afterMs": 2500}},
            {"kind": "media-layout", "payload": {"screenId": "primary", "layoutVersion": 1, "geometry": {}}},
            {"kind": "start-media", "payload": {"mediaLeaseSeq": 1, "ttlMs": 1000, "monotonicDeadlineNs": "9000000000", "testForwardFreezeAfterMs": 2500}},
        ]:
            with self.assertRaises(ValueError):
                instance.command(message, 0)


if __name__ == "__main__":
    unittest.main()
