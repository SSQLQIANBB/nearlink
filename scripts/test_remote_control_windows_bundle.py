"""Candidate dependency audit contracts; no compiler or native execution required."""
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("windows_bundle", Path(__file__).with_name("package-remote-control-engine-windows.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def native_image(path, machine=b"\x64\x86", extra=b""):
    path.parent.mkdir(parents=True, exist_ok=True)
    header = bytearray(64)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 60, 64)
    path.write_bytes(header + b"PE\0\0" + machine + extra)


class WindowsBundleTests(unittest.TestCase):
    def test_forwarded_exports_bring_in_pinned_sdk_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root, sdk = base / "candidate", base / "sdk"
            native_image(root / "runtime/python3.dll")
            native_image(sdk / "gstreamer_plugins_libs/lib/forwarded.dll")
            def dumpbin(args, **_):
                if args[2] == "/exports" and Path(args[3]).name == "python3.dll":
                    return "  1 0 Symbol (forwarded to forwarded.Symbol)\n"
                return ""
            with patch.dict(os.environ, {"SystemRoot": str(base / "windows")}), patch.object(bundle.subprocess, "check_output", side_effect=dumpbin):
                records = bundle.audit_dependencies(root, sdk)
            self.assertEqual(records[0]["imports"], ["forwarded.dll"])
            self.assertEqual(records[1]["sdkSource"], "gstreamer_plugins_libs/lib/forwarded.dll")
            self.assertTrue((root / "sdk/gstreamer_plugins_libs/bin/forwarded.dll").is_file())

    def test_unpinned_package_cannot_satisfy_a_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            native_image(base / "candidate/bin/engine.exe")
            native_image(base / "sdk/unrelated/bin/missing.dll")
            with patch.dict(os.environ, {"SystemRoot": str(base / "windows")}), patch.object(bundle.subprocess, "check_output", return_value="    missing.dll\n"):
                with self.assertRaisesRegex(ValueError, "unresolved or ambiguous"):
                    bundle.audit_dependencies(base / "candidate", base / "sdk")

    def test_duplicate_dll_names_with_different_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            native_image(root / "a/runtime.dll")
            native_image(root / "b/runtime.dll", extra=b"different")
            with self.assertRaisesRegex(ValueError, "ambiguous native dependency"):
                bundle.audit_dependencies(root, root / "sdk")

    def test_non_amd64_binary_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            native_image(root / "engine.exe", machine=b"\x4c\x01")
            with patch.dict(os.environ, {"SystemRoot": str(root / "windows")}):
                with self.assertRaisesRegex(ValueError, "AMD64"):
                    bundle.audit_dependencies(root, root / "sdk")


if __name__ == "__main__":
    unittest.main()
