"""Windows engine readiness/stop check using real authenticated inherited pipes.

Does not send an offer, grant a lease, capture the screen, or inject input.
The source placeholder must never be launched by a readiness-only engine.
"""
import base64
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

from remote_control_ipc import HostIpc


def main():
    if sys.platform != "win32":
        raise SystemExit("Windows required")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-engine", type=Path)
    args = parser.parse_args()
    command = ([str(args.bundle_engine.resolve())] if args.bundle_engine else
               [sys.executable, str(Path(__file__).with_name("remote-control-host-engine.py")),
                "--screen-source", sys.executable])
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
    key, launch, session = os.urandom(32), encode(os.urandom(32)), str(uuid.uuid4())
    codec = HostIpc(session, launch, key, "supervisor")
    child = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    messages, errors = queue.Queue(maxsize=32), bytearray()

    def read():
        try:
            for line in iter(child.stdout.readline, b""):
                messages.put_nowait(codec.decode(line))
        except Exception as error:
            messages.put_nowait(error)

    def diagnostics():
        for line in iter(child.stderr.readline, b""):
            if len(errors) < 8192:
                errors.extend(line[:8192 - len(errors)])

    threading.Thread(target=read, daemon=True).start()
    threading.Thread(target=diagnostics, daemon=True).start()
    ready = stopped = False
    try:
        child.stdin.write(json.dumps({"protocolVersion": 1, "sessionId": session,
                                     "launchId": launch, "key": encode(key)}).encode() + b"\n")
        child.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                message = messages.get(timeout=0.25)
            except queue.Empty:
                if child.poll() is not None:
                    raise RuntimeError("ENGINE_EXITED_BEFORE_STOP: " + errors.decode(errors="replace"))
                child.stdin.write(codec.encode("heartbeat", {}))
                child.stdin.flush()
                continue
            if isinstance(message, Exception):
                raise message
            if message["kind"] == "ready":
                payload = message["payload"]
                if ready or payload["mediaStarted"] is not False or payload["loopbackOnly"] is not True:
                    raise RuntimeError("INVALID_ENGINE_READINESS")
                # Windows venv python.exe is a redirector with a separate worker PID.
                # The packaged native-launcher PID contract is a separate acceptance item.
                engine_pid = payload["pid"]
                if args.bundle_engine and engine_pid != child.pid:
                    raise RuntimeError("BUNDLE_ENGINE_PID_MISMATCH")
                ready = True
                child.stdin.write(codec.encode("stop", {}))
                child.stdin.flush()
            elif message["kind"] == "stopped":
                payload = message["payload"]
                if not ready or payload["frames"] != 0 or payload["screenPid"] is not None:
                    raise RuntimeError("READINESS_STARTED_CAPTURE")
                stopped = True
                break
            else:
                raise RuntimeError("UNEXPECTED_ENGINE_EVENT: " + message["kind"])
        if not stopped:
            raise RuntimeError("ENGINE_STOP_TIMEOUT")
        if child.wait(timeout=5) != 0:
            raise RuntimeError("ENGINE_EXIT_FAILED")
        print(json.dumps({"authenticatedReady": ready, "authenticatedStop": stopped,
                          "childExited": True, "captureStarted": False,
                          "fixedBundle": bool(args.bundle_engine),
                          "launcherPid": child.pid, "enginePid": engine_pid}))
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()


if __name__ == "__main__":
    main()
