"""Cross-platform contract checks; real capture stays in the explicit probe."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location("windows_source", Path(__file__).with_name("remote-control-windows-screen-source.py"))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
host = source.load_host()


class WindowsSourceContractTests(unittest.TestCase):
    def test_macos_caps_unchanged_and_windows_accepts_observed_constrained_baseline(self):
        for platform, profiles in [("posix", "42e01f,42c01f"), ("nt", "42e01f,42c01f,42401f")]:
            with self.subTest(platform=platform), patch.object(host.os, "name", platform):
                caps = host.h264_rtp_caps(103)
                self.assertIn("payload=103,", caps)
                self.assertTrue(caps.endswith("{" + profiles + "}"))
                self.assertNotIn("42001f", caps)

    def test_layout_maps_primary_physical_pixels_and_letterbox(self):
        for width, height, rotation in [(2560, 1600, 0), (1080, 1920, 90), (1920, 1080, 180), (1600, 2560, 270)]:
            with self.subTest(rotation=rotation):
                value = source.layout((0, 0, width, height, rotation))
                tracker = host.MediaLayoutTracker()
                tracker.source(value)
                geometry = tracker.snapshot()["geometry"]
                self.assertEqual(geometry["rotationDegrees"], rotation)
                self.assertEqual(geometry["displayPixels"], {"width": width, "height": height})
                self.assertEqual(geometry["coordinateSpace"], "windows-desktop-physical")
                self.assertTrue(all(number % 2 == 0 for number in geometry["contentRect"].values()))
        self.assertEqual(source.layout((0, 0, 2560, 1600, 0))["geometry"]["contentRect"],
                         {"x": 64, "y": 0, "width": 1152, "height": 720})

    def test_supervisor_stop_eof_and_invalid_command(self):
        for command, expected in [(b"heartbeat\nstop\n", "LOCAL_STOP"),
                                  (b"unexpected\n", "INVALID_SUPERVISOR_MESSAGE"),
                                  (b"x" * 17, "INVALID_SUPERVISOR_MESSAGE"),
                                  (b"", "SUPERVISOR_PIPE_CLOSED")]:
            with self.subTest(command=command):
                reader, writer = os.pipe()
                with os.fdopen(reader, "rb", buffering=0) as stream:
                    try:
                        os.write(writer, command)
                    finally:
                        os.close(writer)
                    supervisor = source.Supervisor(host)
                    with patch.object(sys, "stdin", stream):
                        supervisor.watch()
                    self.assertTrue(supervisor.stopped.is_set())
                    self.assertEqual(supervisor.reason, expected)

    def test_missing_heartbeat_stops_without_waiting_for_media(self):
        supervisor = source.Supervisor(host)
        with patch.object(source.time, "monotonic", side_effect=[0, 3]):
            supervisor.watch()
        self.assertEqual(supervisor.reason, "SUPERVISOR_TIMEOUT")
        self.assertTrue(supervisor.stopped.is_set())

    def test_fail_keeps_macos_signal_and_windows_pipe_shutdown_separate(self):
        for platform in ["posix", "nt"]:
            with self.subTest(platform=platform):
                engine = object.__new__(host.Engine)
                engine.closed = threading.Event()
                engine.media = host.MediaDeadline()
                engine.screen = SimpleNamespace(poll=lambda: None, stdin=io.BytesIO(), terminate=Mock())
                engine.GLib = SimpleNamespace(idle_add=Mock())
                engine.loop = SimpleNamespace(quit=Mock())
                with patch.object(host.os, "name", platform):
                    engine.fail("LOCAL_STOP")
                self.assertEqual(engine.screen.stdin.closed, platform == "nt")
                self.assertEqual(engine.screen.terminate.call_count, int(platform == "posix"))
                self.assertTrue(engine.media.terminal)


if __name__ == "__main__":
    unittest.main()
