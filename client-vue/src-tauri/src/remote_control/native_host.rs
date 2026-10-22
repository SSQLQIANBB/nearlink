//! Product transport pump. Vue relays signaling; all authority and OS operations stay native.
use super::{
    authorization::SignedEnvelope,
    guard::StopReason,
    host_runtime::{Availability, HostResult, HostRuntime},
    host_transport::PreparedHost,
    identity,
    server_clock::ServerClock,
    input::PlatformInputExecutor,
    platform, RemoteControlState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum HostCommand {
    Offer {
        negotiation_id: String,
        sdp: String,
    },
    Candidate {
        candidate: String,
        sdp_m_line_index: u32,
    },
    Connection {
        proof: SignedEnvelope,
    },
    Lease {
        proof: SignedEnvelope,
    },
    Pause,
    Heartbeat,
    Stop,
}
pub(super) struct NativeHostBridge {
    pub session_id: String,
    tx: SyncSender<HostCommand>,
    alive: Arc<AtomicBool>,
}
impl NativeHostBridge {
    pub fn send(&self, command: HostCommand) -> HostResult<()> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("REMOTE_HOST_STOPPED");
        }
        self.tx
            .try_send(command)
            .map_err(|_| "REMOTE_HOST_BACKPRESSURE")
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}
impl Drop for NativeHostBridge {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.tx.try_send(HostCommand::Stop);
    }
}

pub(super) fn launch(
    app: tauri::AppHandle,
    mut prepared: PreparedHost,
    events: tauri::ipc::Channel<Value>,
) -> HostResult<NativeHostBridge> {
    let session_id = prepared.transport.session_id().to_string();
    let (tx, rx) = mpsc::sync_channel(32);
    let alive = Arc::new(AtomicBool::new(true));
    let running = alive.clone();
    let id = session_id.clone();
    thread::Builder::new().name("remote-native-host".into()).spawn(move || {
        let mut runtime: Option<Arc<Mutex<HostRuntime>>> = None;
        let result = (|| -> HostResult<()> {
            let mut connection = None;
            let mut session_clock: Option<ServerClock> = None;
            let mut last_bridge = Instant::now(); let mut last_heartbeat = last_bridge;
            let mut last_challenge = None; let mut ready_sent = false;
            let emit = |kind: &str, payload: Value| events.send(json!({ "sessionId":id, "type":kind, "payload":payload })).map_err(|_| "REMOTE_HOST_BRIDGE_CLOSED");
            while running.load(Ordering::Acquire) {
                let now = Instant::now();
                if now.duration_since(last_bridge) >= Duration::from_secs(3) { return Err("REMOTE_HOST_BRIDGE_TIMEOUT"); }
                match rx.recv_timeout(Duration::from_millis(10)) {
                    Ok(HostCommand::Stop) => break,
                    Ok(HostCommand::Heartbeat) => last_bridge = now,
                    Ok(HostCommand::Offer { negotiation_id, sdp }) => {
                        if sdp.len() > 65536 { return Err("REMOTE_SIGNAL_LIMIT"); }
                        let payload = prepared.transport.offer(&negotiation_id, &sdp, now)?;
                        prepared.driver.send("offer", payload)?;
                    }
                    Ok(HostCommand::Candidate { candidate, sdp_m_line_index }) => {
                        if candidate.len() > 2048 || sdp_m_line_index > 16 { return Err("REMOTE_SIGNAL_LIMIT"); }
                        let started = runtime.as_ref().is_some_and(|r| r.lock().is_ok_and(|r| r.media_started()));
                        let payload = prepared.transport.ice(json!({ "candidate":candidate, "sdpMLineIndex":sdp_m_line_index }), now, started)?;
                        prepared.driver.send("ice", payload)?;
                    }
                    Ok(HostCommand::Connection { proof }) => {
                        if connection.is_some() || runtime.is_some() { return Err("REMOTE_CONNECTION_REPLAY"); }
                        let clock = ServerClock::from_proof(&identity::trusted_keys()?, &proof, Instant::now())?;
                        connection = Some((proof, clock));
                    }
                    Ok(HostCommand::Lease { proof }) => {
                        let clock = ServerClock::from_proof(&identity::trusted_keys()?, &proof, Instant::now())?;
                        runtime.as_ref().ok_or("REMOTE_CONNECTION_REQUIRED")?.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
                            .accept_lease(&proof, clock.now(Instant::now())?, Instant::now())?;
                        session_clock.as_mut().ok_or("REMOTE_CONNECTION_REQUIRED")?.advance(clock, Instant::now())?;
                    }
                    Ok(HostCommand::Pause) => {
                        runtime.as_ref().ok_or("REMOTE_CONNECTION_REQUIRED")?.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?.pause(StopReason::LocalStop)?;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                }
                for _ in 0..32 {
                    let event = match prepared.events.try_recv() { Ok(event) => event, Err(mpsc::TryRecvError::Empty) => break, Err(_) => return Err("REMOTE_ENGINE_PIPE_CLOSED") };
                    let started = runtime.as_ref().is_some_and(|r| r.lock().is_ok_and(|r| r.media_started()));
                    prepared.transport.observe(&event, Instant::now(), started)?;
                    match event.kind.as_str() {
                        "answer" | "ice" => emit(&event.kind, event.payload)?,
                        "error" | "pipe-closed" | "stopped" => {
                            // Only bounded machine codes, never engine stderr or signaling data.
                            if let Some(code) = event.payload.get("reason").or_else(|| event.payload.get("code")).and_then(Value::as_str) {
                                if !code.is_empty() && code.len() <= 64 && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
                                    eprintln!("remote_engine_ended: {code}");
                                }
                            }
                            return Err("REMOTE_ENGINE_STOPPED");
                        },
                        _ => {},
                    }
                }
                if prepared.transport.observed_transport().is_some() && runtime.is_none() {
                    if let Some((proof, clock)) = connection.take() {
                        let input = PlatformInputExecutor::new_primary_screen(1).map_err(|_| "REMOTE_INPUT_UNAVAILABLE")?;
                        runtime = Some(app.state::<RemoteControlState>().connect_native_host(&proof, &mut prepared.transport,
                            Box::new(prepared.driver.clone()), Box::new(input), Box::new(|| {
                                let (capture, input) = platform::permissions();
                                Availability { capture: capture == platform::PermissionState::Granted, input: input == platform::PermissionState::Granted }
                            }), clock.now(Instant::now())?)?);
                        session_clock = Some(clock);
                    }
                }
                if let Some(shared) = &runtime {
                    let mut host = shared.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
                    if host.ended() {
                        eprintln!("remote_host_watchdog_ended: {:?}", host.stop_reason());
                        break;
                    }
                    for (at, label, bytes) in prepared.transport.drain_channels(Instant::now())? {
                        let result = if label == "rc-state-v1" { host.state_message_received(&bytes, at, Instant::now()) } else { host.input_message(&bytes, Instant::now()) };
                        match result { Err("REMOTE_MEDIA_NOT_LIVE" | "REMOTE_CONTROL_NOT_ALLOWED" | "REMOTE_MEDIA_LAYOUT_REQUIRED") => {}, other => other? }
                    }
                    if host.is_ready() {
                        let observed = prepared.transport.observed_transport().ok_or("REMOTE_NATIVE_DTLS_REQUIRED")?;
                        if !ready_sent {
                            emit("native-fact", json!({"proof":host.native_fact(&observed, None, session_clock.as_ref().ok_or("REMOTE_CONNECTION_REQUIRED")?.now(Instant::now())?, Instant::now())?}))?;
                            ready_sent = true;
                        }
                        if last_challenge.is_none_or(|at: Instant| at.elapsed() >= Duration::from_secs(5)) {
                            let challenge = host.challenge(Instant::now())?;
                            emit("native-fact", json!({"proof":host.native_fact(&observed, Some(challenge), session_clock.as_ref().ok_or("REMOTE_CONNECTION_REQUIRED")?.now(Instant::now())?, Instant::now())?}))?;
                            last_challenge = Some(Instant::now());
                        }
                    }
                }
                let started = runtime.as_ref().is_some_and(|r| r.lock().is_ok_and(|r| r.media_started()));
                prepared.transport.check(Instant::now(), started)?;
                if last_heartbeat.elapsed() >= Duration::from_millis(500) {
                    prepared.driver.send("heartbeat", json!({}))?;
                    if let Some(shared) = &runtime { shared.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?.supervisor_heartbeat(Instant::now())?; }
                    last_heartbeat = Instant::now();
                }
            }
            Ok(())
        })();
        running.store(false, Ordering::Release);
        if let Err(code) = result { eprintln!("remote_host_ended: {code}"); }
        if let Some(shared) = runtime { if let Ok(mut host) = shared.lock() { let _ = host.stop(StopReason::LocalStop); } }
        let _ = prepared.driver.terminate_bounded();
        let _ = events.send(json!({ "sessionId":id, "type":"ended", "payload":{ "reason":result.err().unwrap_or("REMOTE_LOCAL_END") } }));
    }).map_err(|_| "REMOTE_NATIVE_WORKER_FAILED")?;
    Ok(NativeHostBridge {
        session_id,
        tx,
        alive,
    })
}
