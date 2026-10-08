"""Build an auditable local macOS arm64 candidate; this is not a release command."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

TARGET = "aarch64-apple-darwin"
SDK_VERSION = "1.28.7"
PYTHON_VERSION = "3.13.2"
PACKAGES = ("gstreamer_libs", "gstreamer_plugins", "gstreamer_plugins_libs", "gstreamer_python")
PLUGINS = {"gstreamer_libs": ("coreelements", "app"), "gstreamer_plugins": (
    "videoparsersbad", "rtp", "rtpmanager", "nice", "dtls", "srtp", "sctp", "webrtc")}
TYPELIBS = ("GLib-2.0", "GObject-2.0", "GModule-2.0", "Gio-2.0", "Gst-1.0", "GstSdp-1.0", "GstWebRTC-1.0")
EXTENSIONS = {"_bisect", "_blake2", "_bz2", "_ctypes", "_contextvars", "_datetime", "_hashlib", "_heapq",
              "_json", "_lzma", "_opcode", "_pickle", "_posixsubprocess", "_random", "_sha2", "_socket",
              "_ssl", "_struct", "array", "binascii", "fcntl", "grp", "math", "mmap", "pyexpat", "resource",
              "select", "unicodedata", "zlib"}


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.PIPE)


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def system_path(value):
    return value.startswith(("/usr/lib/", "/System/Library/"))


def macho(path):
    with path.open("rb") as source:
        return source.read(4) in {b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf"}


def native_info(path):
    commands = run("otool", "-arch", "arm64", "-l", path)
    dependencies = [line.strip().split(" (compatibility", 1)[0] for line in run("otool", "-arch", "arm64", "-L", path).splitlines()[1:] if line.startswith("\t")]
    ids = run("otool", "-arch", "arm64", "-D", path).splitlines()[1:]
    identity = next((value.strip() for value in ids if value.strip() and not value.endswith(":")), None)
    rpaths = re.findall(r"cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.*?) \(offset", commands)
    minimum = re.findall(r"\bminos ([0-9.]+)|\bversion ([0-9.]+)\n\s+sdk", commands)
    minimum = [next(value for value in pair if value) for pair in minimum]
    if not minimum or any(tuple(map(int, value.split("."))) > (13, 0, 0) for value in minimum):
        raise ValueError(f"Unsupported minimum macOS: {path.name}: {minimum}")
    return {"dependencies": [value for value in dependencies if value != identity], "id": identity,
            "rpaths": rpaths, "minimumMacOS": minimum[0]}


def sdk_details(python):
    query = r'''
import importlib.metadata as m,json,sys,sysconfig,os
from pathlib import Path
names=['gstreamer_libs','gstreamer_plugins','gstreamer_plugins_libs','gstreamer_python']
result={'pythonVersion':'.'.join(map(str,sys.version_info[:3])),'base':sys.base_prefix,'sdk':sysconfig.get_paths()['purelib'],'packages':[]}
for name in names:
 d=m.distribution(name)
 result['packages'].append({'name':name,'version':d.version,'licenseDeclaration':d.metadata.get('License'),'metadata':str(d._path/'METADATA')})
os.environ.update(GST_PLUGIN_SYSTEM_PATH_1_0='',GST_PLUGIN_PATH_1_0='',GST_REGISTRY_1_0='/dev/null',GST_REGISTRY_UPDATE='no',GST_REGISTRY_FORK='no')
import gi
gi.require_version('Gst','1.0')
from gi.repository import Gst
Gst.init(None)
result['plugins']=[]
for package,plugins in json.loads(sys.argv[1]).items():
 for name in plugins:
  p=Gst.Plugin.load_file(str(Path(result['sdk'])/package/'lib/gstreamer-1.0'/('libgst'+name+'.dylib')))
  result['plugins'].append({'name':p.get_name(),'version':p.get_version(),'licenseDeclaration':p.get_license(),'sourceProject':p.get_source(),'package':p.get_package(),'origin':p.get_origin()})
print(json.dumps(result))
'''
    return json.loads(run(python, "-c", query, json.dumps(PLUGINS)))


class Builder:
    def __init__(self, root, details):
        self.root = root
        self.sdk = Path(details["sdk"]).resolve()
        self.base = Path(details["base"]).resolve()
        self.gi = self.sdk / "gstreamer_python/lib/python3.13/site-packages"
        self.records = {}
        self.pending = []
        self.by_name = {}
        for folder in [*(self.sdk / package for package in PACKAGES), self.base / "lib"]:
            for path in folder.rglob("*"):
                if path.is_file() and (path.suffix in {".so", ".dylib"}):
                    self.by_name.setdefault(path.name, set()).add(path.resolve())

    def destination(self, source):
        if source.is_relative_to(self.root):
            return source
        if source.is_relative_to(self.gi):
            return self.root / "runtime/site-packages" / source.relative_to(self.gi)
        if source.is_relative_to(self.sdk):
            if source.relative_to(self.sdk).parts[0] not in PACKAGES:
                raise ValueError(f"Disallowed SDK package: {source}")
            return self.root / "sdk" / source.relative_to(self.sdk)
        if source.is_relative_to(self.base):
            return self.root / "runtime" / source.relative_to(self.base)
        raise ValueError(f"Non-bundled dependency: {source}")

    def owner(self, source):
        if source.is_relative_to(self.sdk):
            return source.relative_to(self.sdk).parts[0]
        return "CPython" if source.is_relative_to(self.base) else "NearLink"

    def copy(self, source, destination=None):
        source = source.resolve()
        destination = destination or self.destination(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source != destination:
            shutil.copyfile(source, destination)  # dereference, never hardlink
        destination.chmod(0o644)
        if macho(destination) and source not in self.records:
            info = native_info(source)
            info.update(sourceSha256=digest(source), owner=self.owner(source), path=str(destination.relative_to(self.root)))
            self.records[source] = info
            self.pending.append(source)
        return destination

    def resolve(self, source, dependency, rpaths):
        if system_path(dependency):
            return dependency
        def expand(value):
            return value.replace("@loader_path", str(source.parent)).replace("@executable_path", str(self.base / "bin"))
        candidates = [expand(dependency)]
        if dependency.startswith("@rpath/"):
            suffix = dependency.removeprefix("@rpath/")
            candidates = [str(Path(expand(prefix)) / suffix) for prefix in rpaths]
        for candidate in candidates:
            if system_path(candidate):
                return candidate  # macOS system libraries may live only in dyld cache.
            path = Path(candidate)
            if path.is_absolute() and path.is_file():
                self.destination(path.resolve())  # forbid Homebrew or arbitrary roots.
                return path.resolve()
        options = self.by_name.get(Path(dependency).name, set())
        if len(options) == 1:
            return next(iter(options))
        raise ValueError(f"Unresolved or ambiguous dependency {source.name}: {dependency}")

    def close_dependencies(self):
        while self.pending:
            source = self.pending.pop()
            info = self.records[source]
            resolved = {}
            for dependency in info["dependencies"]:
                target = self.resolve(source, dependency, info["rpaths"])
                resolved[dependency] = target
                if isinstance(target, Path):
                    self.copy(target)
            info["resolved"] = resolved

    def relocate(self):
        self.close_dependencies()
        for source, info in self.records.items():
            target = self.root / info["path"]
            thin = target.with_name(target.name + ".thin")
            run("lipo", source, "-thin", "arm64", "-output", thin) if len(run("lipo", "-archs", source).split()) > 1 else shutil.copyfile(source, thin)
            thin.replace(target)
            target.chmod(0o755)
            changes = []
            if info["id"]:
                changes += ["-id", "@loader_path/" + target.name]
            for dependency, value in info["resolved"].items():
                replacement = value if isinstance(value, str) else "@loader_path/" + os.path.relpath(self.destination(value), target.parent)
                if replacement != dependency:
                    changes += ["-change", dependency, replacement]
            for rpath in info["rpaths"]:
                changes += ["-delete_rpath", rpath]
            if changes:
                run("install_name_tool", *changes, target)
            # Ad-hoc signatures make modified arm64 Mach-O executable locally;
            # these are not Developer ID signatures or notarization evidence.
            run("codesign", "--force", "--sign", "-", "--timestamp=none", target)
            checked = native_info(target)
            if checked["rpaths"]:
                raise ValueError(f"Unexpected runtime search path: {target}")
            for dependency in checked["dependencies"]:
                if system_path(dependency):
                    continue
                if not dependency.startswith("@loader_path/"):
                    raise ValueError(f"Non-relocatable dependency: {dependency}")
                resolved = (target.parent / dependency.removeprefix("@loader_path/")).resolve()
                if not resolved.is_relative_to(self.root) or not resolved.is_file():
                    raise ValueError(f"Escaping or missing dependency: {dependency}")


def build(root, details, scripts):
    builder = Builder(root, details)
    stdlib = builder.base / "lib/python3.13"
    excluded = {"site-packages", "__pycache__", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "venv", "config-3.13-darwin", "lib-dynload"}
    for path in stdlib.rglob("*"):
        relative = path.relative_to(stdlib)
        if path.is_file() and not any(part in excluded for part in relative.parts) and path.suffix in {".py", ".txt"}:
            builder.copy(path)
    for path in (stdlib / "lib-dynload").glob("*.so"):
        if path.name.split(".")[0] in EXTENSIONS:
            builder.copy(path)
    for path in (builder.gi / "gi").rglob("*"):
        if path.is_file() and "__pycache__" not in path.parts and (path.suffix == ".py" or (path.name.startswith(("_gi.", "_gi_gst.")) and path.suffix == ".so")):
            builder.copy(path)
    builder.copy(builder.base / "Python")
    for package, plugins in PLUGINS.items():
        for name in plugins:
            builder.copy(builder.sdk / package / "lib/gstreamer-1.0" / f"libgst{name}.dylib")
    for name in TYPELIBS:
        paths = list(builder.sdk.glob(f"*/lib/girepository-1.0/{name}.typelib"))
        if len(paths) != 1:
            raise ValueError(f"Ambiguous typelib: {name}")
        builder.copy(paths[0], root / "typelib" / paths[0].name)
    for original, target in [("remote-control-bundle-entry.py", "entry.py"), ("remote-control-host-engine.py", "remote_control_host_engine.py"), ("remote_control_ipc.py", "remote_control_ipc.py")]:
        builder.copy(scripts / original, root / "app" / target)
    disabled = root / "runtime/disabled-modules"
    disabled.mkdir()
    (disabled / "README.txt").write_text("Intentionally contains no GIO modules or OpenSSL providers. Fixed package entry disables external module discovery.\n")
    (root / "runtime/openssl.cnf").write_text("# No external OpenSSL configuration, includes or provider modules.\n")
    (root / "bin").mkdir(exist_ok=True)
    launcher = root / "bin/remote-control-engine"
    run("xcrun", "clang", "-arch", "arm64", "-mmacosx-version-min=13.0", "-I" + str(builder.base / "include/python3.13"),
        scripts / "remote-control-bundle-launcher.c", builder.base / "Python", "-o", launcher)
    builder.copy(launcher)
    screen = root / "bin/remote-control-screen-source"
    run("xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos13.0", scripts / "remote-control-screen-source.swift", "-o", screen)
    builder.copy(screen)
    builder.relocate()
    notices = root / "licenses"
    notices.mkdir()
    shutil.copyfile(stdlib / "LICENSE.txt", notices / "CPython-3.13.2-LICENSE.txt")
    for package in details["packages"]:
        shutil.copyfile(package["metadata"], notices / (package["name"] + "-METADATA.txt"))
    inventory = {"status": "local-candidate-not-cleared-for-redistribution", "pythonVersion": PYTHON_VERSION, "gstreamerVersion": SDK_VERSION,
        "target": TARGET, "minimumMacOS": "13.0", "changes": ["arm64 slices only", "relative Mach-O dependencies", "isolated embedded Python launcher", "selected plugins and standard-library modules", "ad-hoc signatures only"],
        "packages": [{key: value for key, value in package.items() if key != "metadata"} for package in details["packages"]],
        "plugins": details["plugins"],
        "nativeFiles": [{key: value for key, value in record.items() if key not in {"resolved", "rpaths"}} for record in builder.records.values()],
        "releaseBlockers": ["Per-component license notices and versions for vendored wheel libraries are not fully supplied by installed wheels.",
            "Complete corresponding sources/build recipes for LGPL components have not been collected or matched to these binary hashes.",
            "Developer ID signing, notarization and validation on a clean macOS 13 host are not complete.",
            "Only loopback ICE and the existing short development session limits have been validated."]}
    (notices / "dependency-inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
    (notices / "README.txt").write_text("LOCAL CANDIDATE ONLY. Package-level wheel license declarations are not a per-library clearance.\nRead dependency-inventory.json releaseBlockers before any distribution.\nUpstream guidance: https://gstreamer.freedesktop.org/documentation/frequently-asked-questions/licensing.html\nCPython: https://docs.python.org/3.13/license.html\nSource changes: only runtime packaging/architecture/link paths; see inventory.\n")
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Unexpected symlink in candidate")
        if path.is_dir():
            path.chmod(0o755)
        elif path.is_file():
            path.chmod(0o755 if macho(path) else 0o644)
            files.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size, "sha256": digest(path),
                          "executable": bool(path.stat().st_mode & 0o111)})
    (root / "manifest.json").write_text(json.dumps({"format": "todesk-engine-bundle-v1", "target": TARGET,
        "entrypoint": "bin/remote-control-engine", "files": files}, separators=(",", ":"), ensure_ascii=False) + "\n")
    (root / "manifest.json").chmod(0o644)
    print(json.dumps({"files": len(files), "bytes": sum(value["size"] for value in files), "nativeFiles": len(builder.records)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-python", type=Path, required=True, help="build-time SDK interpreter; never recorded as a runtime path")
    parser.add_argument("--output", type=Path, required=True, help="new candidate directory, usually dist/remote-control-engine")
    args = parser.parse_args()
    if sys.platform != "darwin" or run("uname", "-m").strip() != "arm64":
        parser.error("requires an Apple Silicon macOS build host")
    details = sdk_details(args.sdk_python)
    if details["pythonVersion"] != PYTHON_VERSION or any(package["version"] != SDK_VERSION for package in details["packages"]):
        parser.error("requires pinned CPython 3.13.2 and GStreamer wheels 1.28.7")
    output = args.output.absolute()
    if output.exists():
        parser.error("output already exists; select a new candidate directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".engine-build-", dir=output.parent) as temporary:
        root = Path(temporary) / "remote-control-engine"
        root.mkdir()
        build(root, details, Path(__file__).resolve().parent)
        root.rename(output)
    print(f"Local candidate: {output}")


if __name__ == "__main__":
    main()
