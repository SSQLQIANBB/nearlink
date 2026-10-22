"""Fixed candidate-bundle entry; not a command-line interface or release gate."""
import ctypes
import os
from pathlib import Path
import sys


def main():
    if len(sys.argv) != 1:
        raise ValueError("BUNDLE_ARGUMENTS_FORBIDDEN")
    root = Path(__file__).resolve().parent.parent
    os.environ.clear()
    disabled_modules = str(root / "runtime/disabled-modules")
    # No registry cache or external plugin scanner. All plugins load explicitly.
    os.environ.update(GST_REGISTRY_DISABLE="yes", GST_REGISTRY_UPDATE="no", GST_REGISTRY_FORK="no",
                      GST_PLUGIN_SCANNER_1_0="", GI_TYPELIB_PATH=str(root / "typelib"),
                      GIO_MODULE_DIR=disabled_modules, GIO_EXTRA_MODULES=disabled_modules,
                      OPENSSL_MODULES=disabled_modules,
                      OPENSSL_CONF=str(root / "runtime/openssl.cnf"),
                      OPENSSL_CONF_INCLUDE=disabled_modules)
    sdk = root / "sdk"
    repository = ctypes.CDLL(str(sdk / "gstreamer_libs/lib/libgirepository-1.0.1.dylib"), mode=ctypes.RTLD_GLOBAL)
    for name in ("g_irepository_prepend_search_path", "g_irepository_prepend_library_path"):
        getattr(repository, name).argtypes = [ctypes.c_char_p]
    repository.g_irepository_prepend_search_path(os.fsencode(root / "typelib"))
    for package in ("gstreamer_libs", "gstreamer_plugins_libs", "gstreamer_plugins"):
        repository.g_irepository_prepend_library_path(os.fsencode(sdk / package / "lib"))
    import remote_control_host_engine as host
    codec = host.read_bootstrap()
    # These values are immutable bundle resources. IPC cannot override paths,
    # SDK location, source arguments, or the disabled test fault switches.
    engine = host.Engine(codec, str(root / "bin/remote-control-screen-source"), host.load_sdk("/dev/null", sdk))
    host.supervise_engine(engine)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("candidate host bundle failed", file=sys.stderr)
        sys.exit(1)
