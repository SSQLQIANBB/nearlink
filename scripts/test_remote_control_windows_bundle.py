"""Candidate dependency audit contracts; no compiler or native execution required."""
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
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


class WindowsRuntimeEnvironmentTests(unittest.TestCase):
    def entry(self):
        spec = importlib.util.spec_from_file_location("windows_entry", Path(__file__).with_name("remote-control-windows-bundle-entry.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def windows(self, local, fail=False):
        def system(buffer, size):
            buffer.value = "C:\\Windows"
            return len(buffer.value)

        def folder(hwnd, csidl, token, flags, buffer):
            if fail:
                return -1
            buffer.value = str(local / {0x001c: "local", 0x001a: "roaming", 0x0028: "profile"}[csidl])
            return 0

        return SimpleNamespace(kernel32=SimpleNamespace(GetWindowsDirectoryW=system),
                               shell32=SimpleNamespace(SHGetFolderPathW=folder))

    def test_driver_logs_cannot_pollute_the_verified_bundle_and_environment_stays_isolated(self):
        entry = self.entry()
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / "remote-control-engine"
            root.mkdir()
            (root / "manifest.json").write_text("fixture", encoding="utf-8")
            before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            try:
                os.chdir(root)
                with patch.object(entry.ctypes, "windll", self.windows(base), create=True), patch.dict(os.environ, {
                    "LOCALAPPDATA": str(root), "PYTHONPATH": str(root), "PATH": "untrusted",
                    "GST_PLUGIN_PATH_1_0": str(root), "GST_REGISTRY_DISABLE": "no",
                }):
                    entry.configure_environment(root)
                    self.assertEqual(Path.cwd(), base / "local/NearLink/remote-control-runtime")
                    self.assertEqual(os.environ["LOCALAPPDATA"], str(base / "local"))
                    self.assertEqual(os.environ["USERPROFILE"], str(base / "profile"))
                    self.assertEqual(os.environ["SystemRoot"], "C:\\Windows")
                    self.assertEqual(os.environ["SystemDrive"], "C:")
                    self.assertTrue(Path(os.environ["TEMP"]).is_dir())
                    self.assertEqual(os.environ["TMP"], os.environ["TEMP"])
                    self.assertEqual(os.environ["GST_REGISTRY_DISABLE"], "yes")
                    for name in ("PYTHONPATH", "PATH", "GST_PLUGIN_PATH_1_0"):
                        self.assertNotIn(name, os.environ)
                    # Reproduce the exact directory from the user's Windows archive.
                    log = Path("NVIDIA Corporation/umdlogs/driver.log")
                    log.parent.mkdir(parents=True)
                    log.write_text("driver diagnostic", encoding="utf-8")
                    self.assertEqual(before, sorted(path.relative_to(root).as_posix() for path in root.rglob("*")))
            finally:
                os.chdir(original)

    def test_unavailable_windows_profile_never_falls_back_to_the_installation_directory(self):
        entry = self.entry()
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(entry.ctypes, "windll", self.windows(Path(temporary), fail=True), create=True):
                with self.assertRaisesRegex(OSError, "WINDOWS_PROFILE_DIRECTORY_UNAVAILABLE"):
                    entry.configure_environment(Path(temporary))
            self.assertEqual(Path.cwd(), original)


if __name__ == "__main__":
    unittest.main()
