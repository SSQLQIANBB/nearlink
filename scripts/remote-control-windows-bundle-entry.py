"""Fixed Windows candidate entry; SDK/source paths cannot come from IPC or argv."""
import os
import ctypes
from pathlib import Path, PureWindowsPath
import sys
import threading


def configure_environment(root):
    # Resolve these from Windows, not inherited environment or IPC. GPU drivers
    # need LOCALAPPDATA/USERPROFILE even when Python itself runs isolated.
    system_directory = ctypes.create_unicode_buffer(32768)
    length = ctypes.windll.kernel32.GetWindowsDirectoryW(system_directory, len(system_directory))
    if not 0 < length < len(system_directory):
        raise OSError("WINDOWS_DIRECTORY_UNAVAILABLE")
    folders = {}
    for name, csidl in (("LOCALAPPDATA", 0x001c), ("APPDATA", 0x001a), ("USERPROFILE", 0x0028)):
        value = ctypes.create_unicode_buffer(32768)
        result = ctypes.windll.shell32.SHGetFolderPathW(None, csidl, None, 0, value)
        if result != 0 or not value.value or not Path(value.value).is_absolute():
            raise OSError("WINDOWS_PROFILE_DIRECTORY_UNAVAILABLE")
        folders[name] = value.value
    working = Path(folders["LOCALAPPDATA"]) / "NearLink" / "remote-control-runtime"
    temporary = working / "temp"
    temporary.mkdir(parents=True, exist_ok=True)
    # Even a driver which falls back to cwd must never write into the immutable
    # application bundle. Both the host and screen source execute this entry.
    os.chdir(working)
    os.environ.clear()
    os.environ.update(folders, SystemRoot=system_directory.value, windir=system_directory.value,
                      SystemDrive=PureWindowsPath(system_directory.value).drive,
                      TEMP=str(temporary), TMP=str(temporary))
    disabled = str(root / "runtime/disabled-modules")
    # UPDATE=no alone still permits a first-run cache write when no cache exists.
    # All required plugins are loaded explicitly from the verified SDK below.
    os.environ.update(GST_REGISTRY_DISABLE="yes", GST_REGISTRY_UPDATE="no", GST_REGISTRY_FORK="no",
                      GST_PLUGIN_SCANNER_1_0="", GIO_MODULE_DIR=disabled,
                      GIO_EXTRA_MODULES=disabled, OPENSSL_MODULES=disabled,
                      OPENSSL_CONF=str(root / "runtime/openssl.cnf"),
                      OPENSSL_CONF_INCLUDE=disabled)


def main():
    if len(sys.argv) != 1 or sys.platform != "win32":
        raise ValueError("BUNDLE_ARGUMENTS_FORBIDDEN")
    root = Path(__file__).resolve().parent.parent
    configure_environment(root)
    import remote_control_host_engine as host
    sdk = root / "sdk"
    if Path(sys.executable).name == "remote-control-engine.exe":
        codec = host.read_bootstrap()
        engine = host.Engine(codec, str(root / "bin/remote-control-screen-source.exe"),
                             host.load_sdk("NUL", sdk))
        host.supervise_engine(engine)
    elif Path(sys.executable).name == "remote-control-screen-source.exe":
        import remote_control_windows_screen_source as source
        os.set_blocking(sys.stdout.fileno(), False)
        os.set_blocking(sys.stderr.fileno(), False)
        supervisor = source.Supervisor(host)
        watcher = threading.Thread(target=supervisor.watch, daemon=True)
        watcher.start()
        try:
            source.run(host, host.load_gst("NUL", sdk), supervisor)
        finally:
            supervisor.stop("LOCAL_STOP")
            watcher.join(timeout=0.2)
    else:
        raise ValueError("BUNDLE_ENTRY_REJECTED")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("candidate Windows bundle failed", file=sys.stderr)
        sys.exit(1)
