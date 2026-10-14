"""Build a local Windows x64 candidate; native trust admission/release stay closed.

Run with the pinned SDK's Python from an MSVC developer shell. No pip/install or
PATH-based runtime dependencies are packaged. Each output must be a new directory.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import struct
import sys
import sysconfig
import tempfile

SDK_VERSION = "1.28.7"
PACKAGES = ("gstreamer_libs", "gstreamer_plugins", "gstreamer_plugins_libs",
            "gstreamer_python", "gstreamer_ext_runtime")
PLUGINS = {"gstreamer_libs": ("coreelements", "app", "videoconvertscale"),
           "gstreamer_plugins": ("videoparsersbad", "rtp", "rtpmanager", "nice", "dtls",
                                 "srtp", "sctp", "webrtc", "d3d11", "mediafoundation", "videobox")}


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def copy(source, destination):
    if source.is_symlink() or source.is_junction():
        raise ValueError("linked build input rejected: " + str(source))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def copy_tree(source, destination, excluded=()):
    for directory, names, files in os.walk(source, followlinks=False):
        names[:] = [name for name in names if name not in excluded and name != "__pycache__"]
        directory = Path(directory)
        if any((directory / name).is_symlink() or (directory / name).is_junction() for name in names):
            raise ValueError("linked build directory rejected")
        for name in files:
            if not name.endswith((".pyc", ".pyo")):
                copy(directory / name, destination / directory.relative_to(source) / name)


def audit_dependencies(root, sdk):
    native = sorted(path for path in root.rglob("*") if path.suffix.lower() in {".exe", ".dll", ".pyd"})
    bundled = {}
    for path in native:
        prior = bundled.setdefault(path.name.lower(), path)
        if prior != path and digest(prior) != digest(path):
            raise ValueError("ambiguous native dependency: " + path.name)
    system = Path(os.environ["SystemRoot"]) / "System32"
    available = {}
    for package in PACKAGES:
        for path in sorted((sdk / package).rglob("*.dll")):
            available.setdefault(path.name.lower(), []).append(path)
    relocated = {}
    records = []
    for path in native:
        with path.open("rb") as file:
            header = file.read(64)
            if len(header) != 64 or header[:2] != b"MZ":
                raise ValueError("invalid native image: " + path.name)
            file.seek(struct.unpack_from("<I", header, 60)[0])
            if file.read(6) != b"PE\0\0\x64\x86":
                raise ValueError("requires AMD64 native image: " + path.name)
        output = subprocess.check_output(["dumpbin.exe", "/nologo", "/dependents", str(path)], text=True)
        dependencies = re.findall(r"^\s+([\w.-]+\.dll)\s*$", output, re.M | re.I)
        # Stable-ABI python3.dll forwards exports rather than importing Python.
        exports = subprocess.check_output(["dumpbin.exe", "/nologo", "/exports", str(path)], text=True)
        dependencies += [name + ".dll" for name in re.findall(r"\(forwarded to ([\w-]+)\.", exports)]
        dependencies = sorted(set(dependencies), key=str.lower)
        for dependency in dependencies:
            name = dependency.lower()
            if name not in bundled and not name.startswith(("api-ms-win-", "ext-ms-win-")) and not (system / dependency).is_file():
                candidates = available.get(name, [])
                if not candidates or len({digest(candidate) for candidate in candidates}) != 1:
                    raise ValueError(f"unresolved or ambiguous dependency: {path.name} -> {dependency}")
                source = candidates[0]
                destination = root / "sdk/gstreamer_plugins_libs/bin" / source.name
                copy(source, destination)
                bundled[name] = destination
                native.append(destination)
                relocated[destination] = source.relative_to(sdk).as_posix()
        record = {"path": path.relative_to(root).as_posix(), "imports": dependencies}
        if path in relocated:
            record["sdkSource"] = relocated[path]
        records.append(record)
    return records


def build(root, base, sdk):
    runtime = root / "runtime"
    copy_tree(base / "Lib", runtime / "Lib", {"site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "venv"})
    for path in (base / "DLLs").iterdir():
        if path.suffix.lower() in {".dll", ".pyd"} and not path.name.startswith(("_test", "_tkinter", "tcl", "tk")):
            copy(path, runtime / "DLLs" / path.name)
    for name in ("python313.dll", "python3.dll", "LICENSE.txt"):
        copy(base / name, runtime / name)
    # Use the pinned SDK's one MSVC runtime throughout the candidate. Different
    # DLLs with the same basename otherwise depend on Windows load order.
    for name in ("vcruntime140.dll", "vcruntime140_1.dll"):
        copy(sdk / "gstreamer_ext_runtime/bin" / name, runtime / name)
    (runtime / "openssl.cnf").write_text("# No external OpenSSL configuration or providers.\n", encoding="utf-8")
    for package in PACKAGES:
        typelibs = sdk / package / "lib/girepository-1.0"
        if typelibs.is_dir():
            copy_tree(typelibs, root / "sdk" / package / "lib/girepository-1.0")
        for path in (sdk / package / "bin").glob("*.dll"):
            copy(path, root / "sdk" / package / "bin" / path.name)
        for path in (sdk / package).rglob("*LICENSE*"):
            if path.is_file():
                copy(path, root / "sdk" / package / path.relative_to(sdk / package))
        distribution = importlib.metadata.distribution(package)
        for relative in distribution.files or []:
            if ".dist-info" in str(relative) and ("license" in str(relative).lower() or Path(relative).name in {"METADATA", "WHEEL"}):
                copy(sdk / relative, root / "sdk" / relative)
    for package, names in PLUGINS.items():
        for name in names:
            relative = Path(package) / "lib/gstreamer-1.0" / f"gst{name}.dll"
            copy(sdk / relative, root / "sdk" / relative)
    copy_tree(sdk / "gstreamer_python/Lib", root / "sdk/gstreamer_python/Lib")
    scripts = Path(__file__).parent
    for source, target in {"remote-control-host-engine.py": "remote_control_host_engine.py",
                           "remote-control-windows-screen-source.py": "remote_control_windows_screen_source.py",
                           "remote_control_ipc.py": "remote_control_ipc.py",
                           "remote-control-windows-bundle-entry.py": "entry.py"}.items():
        copy(scripts / source, root / "app" / target)
    binary = root / "bin/remote-control-engine.exe"
    binary.parent.mkdir()
    subprocess.run(["cl.exe", "/nologo", "/O2", "/MT", "/W4",
                    f"/I{base / 'include'}", str(scripts / "remote-control-windows-bundle-launcher.c"),
                    f"/Fo{root / 'launcher.obj'}", f"/Fe{binary}", "/link",
                    f"/LIBPATH:{base / 'libs'}", "python313.lib", "delayimp.lib", "/DELAYLOAD:python313.dll"], check=True)
    (root / "launcher.obj").unlink()
    copy(binary, root / "bin/remote-control-screen-source.exe")
    records = audit_dependencies(root, sdk)
    (root / "build-evidence.json").write_text(json.dumps({
        "candidateOnly": True, "pythonVersion": sys.version.split()[0], "sdkVersion": SDK_VERSION,
        "nativeImports": records}, indent=2), encoding="utf-8")
    files = [{"path": path.relative_to(root).as_posix(), "size": path.stat().st_size,
              "sha256": digest(path), "executable": path.suffix.lower() == ".exe"}
             for path in sorted(root.rglob("*"), key=lambda value: value.relative_to(root).as_posix()) if path.is_file()]
    manifest = {"format": "todesk-engine-bundle-v1", "target": "x86_64-pc-windows-msvc",
                "entrypoint": "bin/remote-control-engine.exe", "files": files}
    (root / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return {"files": len(files), "bytes": sum(file["size"] for file in files), "nativeFiles": len(records)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "win32" or sys.maxsize <= 2**32 or sys.version_info[:2] != (3, 13):
        parser.error("requires Windows x64 CPython 3.13 SDK interpreter")
    if any(importlib.metadata.version(package) != SDK_VERSION for package in PACKAGES):
        parser.error("requires GStreamer SDK wheels 1.28.7")
    output = args.output.absolute()
    if output.exists():
        parser.error("output already exists; select a new candidate directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".windows-engine-build-", dir=output.parent) as temporary:
        root = Path(temporary) / "remote-control-engine"
        root.mkdir()
        result = build(root, Path(sys.base_prefix), Path(sysconfig.get_paths()["purelib"]))
        root.rename(output)
    print(json.dumps({"output": str(output), "candidateOnly": True, **result}))


if __name__ == "__main__":
    main()
