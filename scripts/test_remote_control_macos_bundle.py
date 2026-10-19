"""Architecture selection contracts without executing macOS toolchains."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("macos_bundle", Path(__file__).with_name("package-remote-control-engine.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class MacOSBundleTests(unittest.TestCase):
    def test_dependency_inspection_uses_selected_slice(self):
        for architecture in ("arm64", "x86_64"):
            calls = []

            def run(*args):
                calls.append(args)
                if args[0] == "lipo":
                    return "arm64 x86_64"
                if "-l" in args:
                    return "cmd LC_BUILD_VERSION\n minos 13.0\n"
                return "sample:\n"

            with patch.object(bundle, "ARCH", architecture), patch.object(bundle, "run", side_effect=run):
                self.assertEqual(bundle.native_info(Path("sample"))["minimumMacOS"], "13.0")
            self.assertTrue(all(call[2] == architecture for call in calls if call[0] == "otool"))

    def test_wrong_architecture_is_rejected_before_dependency_copy(self):
        with patch.object(bundle, "ARCH", "x86_64"), patch.object(bundle, "run", return_value="arm64"):
            with self.assertRaisesRegex(ValueError, "Missing x86_64 slice"):
                bundle.native_info(Path("arm-only.dylib"))


if __name__ == "__main__":
    unittest.main()
