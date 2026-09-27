//! Fixed, hash-checked bundled programs and authenticated inherited-pipe IPC.
//! Dynamic development paths exist only in the explicit CLI harness feature.
#![allow(dead_code)]
use super::{
    authorization::VerifiedLease,
    host_runtime::{HostResult, MediaDriver},
    ipc::{self, IpcCodec, IpcMessage, IpcSession},
    media_layout::{LayoutTracker, MediaLayout},
    media_liveness::{self, NativeMediaProgress},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
#[cfg(feature = "remote-control-harness")]
use sha2::{Digest, Sha256};
#[cfg(feature = "remote-control-harness")]
use std::{
    ffi::OsString,
    fs::File,
    path::{Path, PathBuf},
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_PROGRAM_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(feature = "remote-control-harness")]
pub(super) struct VerifiedProgram {
    path: PathBuf,
    sha256: String,
}
#[cfg(feature = "remote-control-harness")]
impl VerifiedProgram {
    #[cfg(feature = "remote-control-harness")]
    pub fn harness(path: &Path, sha256: &str) -> HostResult<Self> {
        // Preserve an explicit virtualenv launcher path; replacing its symlink
        // with the base interpreter would silently lose the isolated SDK.
        let path = std::path::absolute(path).map_err(|_| "REMOTE_SIDECAR_PATH_REJECTED")?;
        let program = Self {
            path,
            sha256: sha256.into(),
        };
        program.verify()?;
        Ok(program)
    }
    fn verify(&self) -> HostResult<()> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("REMOTE_SIDECAR_HASH_REJECTED");
        }
        let mut file = File::open(&self.path).map_err(|_| "REMOTE_SIDECAR_PATH_REJECTED")?;
        let metadata = file
            .metadata()
            .map_err(|_| "REMOTE_SIDECAR_PATH_REJECTED")?;
        if !metadata.is_file() || metadata.len() > MAX_PROGRAM_BYTES {
            return Err("REMOTE_SIDECAR_PATH_REJECTED");
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut total = 0;
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| "REMOTE_SIDECAR_HASH_REJECTED")?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > MAX_PROGRAM_BYTES {
                return Err("REMOTE_SIDECAR_HASH_REJECTED");
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != self.sha256 {
            return Err("REMOTE_SIDECAR_HASH_REJECTED");
        }
        Ok(())
    }
}
struct ProcessState {
    child: Mutex<ReapedChild>,
    writer: SyncSender<Vec<u8>>,
    codec: Mutex<IpcCodec>,
    alive: Arc<AtomicBool>,
    progress: Mutex<NativeMediaProgress>,
    layout: Mutex<LayoutTracker>,
}
// Own the child immediately after spawn, including every early-error path.
// Dropping std::process::Child alone neither terminates nor reaps it.
struct ReapedChild(Option<Child>);
impl std::ops::Deref for ReapedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.0.as_ref().expect("owned child")
    }
}
impl std::ops::DerefMut for ReapedChild {
    fn deref_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("owned child")
    }
}
impl Drop for ReapedChild {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        // A slow OS must not block the application destructor indefinitely.
        // Ownership stays with a reaper until wait observes the actual exit.
        thread::spawn(move || {
            let _ = child.wait();
        });
    }
}
#[derive(Clone)]
pub(super) struct ProcessMediaDriver(Arc<ProcessState>);
impl ProcessMediaDriver {
    /// Readiness probe: authenticated engine handshake, never configure networking,
    /// grant a media lease, capture the screen or create a local consent.
    pub fn probe_bundled(app: &tauri::AppHandle) -> HostResult<()> {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| "REMOTE_RANDOM_UNAVAILABLE")?;
        bytes[6] = (bytes[6] & 15) | 0x40;
        bytes[8] = (bytes[8] & 63) | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let session = format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]);
        let (driver, events) = Self::spawn_bundled(app, &session)?;
        let result = (|| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if Instant::now() >= deadline { return Err("REMOTE_ENGINE_PROBE_TIMEOUT"); }
                driver.send("heartbeat", json!({}))?;
                match events.recv_timeout(Duration::from_millis(400)) {
                    Ok(event) if event.kind == "ready"
                        && event.payload["pid"].as_u64() == Some(driver.pid()? as u64)
                        && event.payload["mediaStarted"] == false
                        && event.payload["loopbackOnly"] == true => return Ok(()),
                    Ok(_) => return Err("REMOTE_ENGINE_PROBE_REJECTED"),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Err("REMOTE_ENGINE_PROBE_REJECTED"),
                    Err(mpsc::RecvTimeoutError::Timeout) => (),
                }
            }
        })();
        let stopped = driver.terminate_bounded();
        result.and(stopped)
    }
    #[cfg(all(test, unix))]
    pub(super) fn idle_test_process(session_id: &str) -> HostResult<(Self, Receiver<IpcMessage>)> {
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        Self::spawn_command(command, session_id)
    }
    /// Native-only product factory. Resource location comes from Tauri itself.
    pub fn spawn_bundled(
        app: &tauri::AppHandle,
        session_id: &str,
    ) -> HostResult<(Self, Receiver<IpcMessage>)> {
        let bundle = super::engine_bundle::TrustedEngineBundle::from_app(app)
            .map_err(|_| "REMOTE_ENGINE_BUNDLE_REJECTED")?;
        let command = bundle
            .command()
            .map_err(|_| "REMOTE_ENGINE_BUNDLE_REJECTED")?;
        Self::spawn_command(command, session_id)
    }
    #[cfg(feature = "remote-control-harness")]
    pub fn spawn(
        program: VerifiedProgram,
        script: Option<VerifiedProgram>,
        args: &[OsString],
        session_id: &str,
    ) -> HostResult<(Self, Receiver<IpcMessage>)> {
        program.verify()?;
        if let Some(script) = &script {
            script.verify()?;
        }
        let mut command = Command::new(&program.path);
        if let Some(script) = &script {
            command.arg(&script.path);
        }
        command.args(args);
        Self::spawn_command(command, session_id)
    }
    fn spawn_command(
        mut command: Command,
        session_id: &str,
    ) -> HostResult<(Self, Receiver<IpcMessage>)> {
        let session = IpcSession::new(session_id).map_err(|_| "REMOTE_IPC_BOOTSTRAP_FAILED")?;
        let bootstrap = session
            .bootstrap_line()
            .map_err(|_| "REMOTE_IPC_BOOTSTRAP_FAILED")?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = ReapedChild(Some(
            command.spawn().map_err(|_| "REMOTE_SIDECAR_SPAWN_FAILED")?,
        ));
        let mut stdin = child.stdin.take().ok_or("REMOTE_SIDECAR_PIPE_FAILED")?;
        let stdout = child.stdout.take().ok_or("REMOTE_SIDECAR_PIPE_FAILED")?;
        let stderr = child.stderr.take().ok_or("REMOTE_SIDECAR_PIPE_FAILED")?;
        let (writer, write_rx) = mpsc::sync_channel::<Vec<u8>>(32);
        let alive = Arc::new(AtomicBool::new(true));
        let write_alive = alive.clone();
        thread::spawn(move || {
            for frame in write_rx {
                let frame = Zeroizing::new(frame);
                if stdin.write_all(&frame).is_err() || stdin.flush().is_err() {
                    break;
                }
            }
            write_alive.store(false, Ordering::Release);
        });
        writer
            .try_send(bootstrap)
            .map_err(|_| "REMOTE_SIDECAR_PIPE_FAILED")?;
        let state = Arc::new(ProcessState {
            child: Mutex::new(child),
            writer,
            codec: Mutex::new(session.supervisor_codec()),
            alive,
            progress: Mutex::new(NativeMediaProgress::default()),
            layout: Mutex::new(LayoutTracker::default()),
        });
        let (event_tx, event_rx) = mpsc::sync_channel(128);
        let weak = Arc::downgrade(&state);
        let read_alive = state.alive.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut clean_eof = false;
            loop {
                let mut frame = Vec::new();
                let read = reader
                    .by_ref()
                    .take((ipc::MAX_LINE_BYTES + 1) as u64)
                    .read_until(b'\n', &mut frame);
                if matches!(read, Ok(0)) {
                    clean_eof = true;
                    break;
                }
                if !matches!(read,Ok(n) if n>0) || frame.len() > ipc::MAX_LINE_BYTES {
                    break;
                }
                let Some(state) = weak.upgrade() else {
                    break;
                };
                let message = state
                    .codec
                    .lock()
                    .ok()
                    .and_then(|mut codec| codec.decode(&frame).ok());
                let Some(message) = message else {
                    break;
                };
                // Record bounded machine diagnostics before watchdog health checks
                // can preempt the adapter's queued error/EOF observation.
                if matches!(message.kind.as_str(), "error" | "stopped") {
                    if let Some(code) = message.payload.get("reason").or_else(|| message.payload.get("code")).and_then(Value::as_str) {
                        if !code.is_empty() && code.len() <= 64 && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
                            eprintln!("remote_engine_terminal: {}", code);
                        }
                    }
                }
                if message.kind == "media-layout"
                    && state
                        .layout
                        .lock()
                        .ok()
                        .and_then(|mut layout| layout.observe(message.payload.clone()).ok())
                        .is_none()
                {
                    break;
                }
                if message.kind == "error"
                    && message.payload.get("reason").and_then(Value::as_str)
                        == Some("MEDIA_LAYOUT_CHANGED")
                {
                    if let Ok(mut layout) = state.layout.lock() {
                        layout.invalidate();
                    }
                }
                if message.kind == "media-progress" {
                    let observed = media_liveness::clock_sample().and_then(|(clock, at)| {
                        state
                            .progress
                            .lock()
                            .map_err(|_| "REMOTE_MEDIA_PROGRESS_INVALID")?
                            .observe(message.payload.clone(), clock, at)
                    });
                    if observed.is_err() {
                        eprintln!("remote_engine_pipe: MEDIA_PROGRESS_REJECTED");
                        break;
                    }
                }
                if event_tx.try_send(message).is_err() {
                    eprintln!("remote_engine_pipe: EVENT_QUEUE_UNAVAILABLE");
                    break;
                }
            }
            read_alive.store(false, Ordering::Release);
            let _=event_tx.try_send(IpcMessage{kind:if clean_eof {"pipe-closed"} else {"error"}.into(),payload:json!({"code":if clean_eof {"REMOTE_IPC_CLOSED"} else {"REMOTE_IPC_REJECTED"}}),received_at:Instant::now()});
        });
        // Drain diagnostics without disclosing SDP, key material or captured data.
        thread::spawn(move || {
            let mut reader = stderr;
            let mut bytes = [0u8; 4096];
            while matches!(reader.read(&mut bytes),Ok(n) if n>0) {}
        });
        Ok((Self(state), event_rx))
    }
    pub fn send(&self, kind: &str, payload: Value) -> HostResult<()> {
        if !self.0.alive.load(Ordering::Acquire) {
            return Err("REMOTE_IPC_CLOSED");
        }
        // Keep sequence allocation and bounded enqueue in one critical section.
        let mut codec = self.0.codec.lock().map_err(|_| "REMOTE_IPC_CLOSED")?;
        let frame = codec
            .encode(kind, payload)
            .map_err(|_| "REMOTE_IPC_REJECTED")?;
        self.0.writer.try_send(frame).map_err(|_| {
            self.0.alive.store(false, Ordering::Release);
            "REMOTE_IPC_BACKPRESSURE"
        })
    }
    pub fn pid(&self) -> HostResult<u32> {
        Ok(self
            .0
            .child
            .lock()
            .map_err(|_| "REMOTE_PROCESS_STATE_FAILED")?
            .id())
    }
    fn media_lease(&self, kind: &str, lease: &VerifiedLease, now: Instant) -> HostResult<()> {
        let ttl = lease
            .deadline()
            .checked_duration_since(now)
            .ok_or("REMOTE_MEDIA_LEASE_EXPIRED")?
            .as_millis();
        if ttl == 0 || ttl > 15000 {
            return Err("REMOTE_MEDIA_LEASE_EXPIRED");
        }
        let deadline = ipc::monotonic_deadline_ns(lease.deadline())
            .map_err(|_| "REMOTE_MEDIA_LEASE_EXPIRED")?;
        self.send(kind,json!({"mediaLeaseSeq":lease.lease_seq(),"ttlMs":ttl as u64,"monotonicDeadlineNs":deadline}))
    }
    pub fn terminate_bounded(&self) -> HostResult<()> {
        let _ = self.send("stop", json!({}));
        let mut child = self
            .0
            .child
            .lock()
            .map_err(|_| "REMOTE_PROCESS_STATE_FAILED")?;
        let deadline = Instant::now() + Duration::from_millis(700);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.0.alive.store(false, Ordering::Release);
                    return Ok(());
                }
                Err(_) => break,
                _ => (),
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_millis(700);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                self.0.alive.store(false, Ordering::Release);
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.0.alive.store(false, Ordering::Release);
        Err("REMOTE_SIDECAR_EXIT_UNCONFIRMED")
    }
}
impl MediaDriver for ProcessMediaDriver {
    fn start_media(&mut self, lease: &VerifiedLease, now: Instant) -> HostResult<()> {
        self.media_lease("start-media", lease, now)
    }
    fn renew_media(&mut self, lease: &VerifiedLease, now: Instant) -> HostResult<()> {
        self.media_lease("renew-media", lease, now)
    }
    fn stop_media(&mut self) -> HostResult<()> {
        if !self.0.alive.load(Ordering::Acquire) {
            return Ok(());
        }
        self.send("stop-media", json!({}))
    }
    fn terminate(&mut self) -> HostResult<()> {
        self.terminate_bounded()
    }
    fn send_channel(&mut self, label: &str, data: &[u8]) -> HostResult<()> {
        if !["rc-state-v1", "rc-input-v1"].contains(&label) || data.len() > 4096 {
            return Err("REMOTE_CHANNEL_REJECTED");
        }
        self.send(
            "send-channel",
            json!({"label":label,"data":URL_SAFE_NO_PAD.encode(data)}),
        )
    }
    fn healthy(&self) -> bool {
        self.0.alive.load(Ordering::Acquire)
    }
    fn media_progress(&self) -> HostResult<NativeMediaProgress> {
        self.0
            .progress
            .lock()
            .map(|progress| *progress)
            .map_err(|_| "REMOTE_MEDIA_PROGRESS_INVALID")
    }
    fn media_layout(&self) -> HostResult<Option<MediaLayout>> {
        self.0
            .layout
            .lock()
            .map_err(|_| "REMOTE_MEDIA_LAYOUT_CHANGED")?
            .snapshot()
    }
}
impl Drop for ProcessState {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn early_error_child_owner_terminates_and_reaps() {
        let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        drop(ReapedChild(Some(child)));
        // No screen/input work occurs: this child is only a sleeping process.
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "child remained after owner drop");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}
