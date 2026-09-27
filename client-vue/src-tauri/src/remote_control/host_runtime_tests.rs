use super::super::{
    authorization::{PinnedKey, DOMAIN},
    identity::{approve_harness_fixture, Decision},
    input::{InputAction, InputEnvironment, InputError},
};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Default)]
struct Log {
    starts: usize,
    renews: usize,
    stops: usize,
    terminates: usize,
    terminate_failures: usize,
    actions: usize,
    released: Vec<String>,
    channels: Vec<Value>,
    progress: NativeMediaProgress,
    deadlines: Vec<Instant>,
    unhealthy: bool,
    layout: Option<MediaLayout>,
    display: Option<DisplaySnapshot>,
    layout_failed: bool,
}
struct Driver(Arc<Mutex<Log>>);
impl MediaDriver for Driver {
    fn start_media(&mut self, _: &VerifiedLease, _: Instant) -> HostResult<()> {
        self.0.lock().unwrap().starts += 1;
        Ok(())
    }
    fn renew_media(&mut self, _: &VerifiedLease, _: Instant) -> HostResult<()> {
        self.0.lock().unwrap().renews += 1;
        Ok(())
    }
    fn stop_media(&mut self) -> HostResult<()> {
        self.0.lock().unwrap().stops += 1;
        Ok(())
    }
    fn terminate(&mut self) -> HostResult<()> {
        let mut log = self.0.lock().unwrap();
        log.terminates += 1;
        if log.terminate_failures > 0 {
            log.terminate_failures -= 1;
            return Err("REMOTE_SIDECAR_EXIT_UNCONFIRMED");
        }
        Ok(())
    }
    fn send_channel(&mut self, _: &str, bytes: &[u8]) -> HostResult<()> {
        self.0
            .lock()
            .unwrap()
            .channels
            .push(serde_json::from_slice(bytes).unwrap());
        Ok(())
    }
    fn healthy(&self) -> bool {
        !self.0.lock().unwrap().unhealthy
    }
    fn media_progress(&self) -> HostResult<NativeMediaProgress> {
        Ok(self.0.lock().unwrap().progress)
    }
    fn media_layout(&self) -> HostResult<Option<MediaLayout>> {
        let log = self.0.lock().unwrap();
        if log.layout_failed {
            Err("REMOTE_MEDIA_LAYOUT_CHANGED")
        } else {
            Ok(log.layout.clone())
        }
    }
}
struct Sink(Arc<Mutex<Log>>, Arc<AtomicBool>);
impl InputExecutor for Sink {
    fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
        self.0
            .lock()
            .unwrap()
            .display
            .ok_or(InputError::LayoutChanged)
    }
    fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
        Ok(InputEnvironment {
            screen_id: "primary".into(),
            layout_version: 1,
        })
    }
    fn execute(&mut self, _: &InputAction, deadline: Instant) -> Result<(), InputError> {
        let mut log = self.0.lock().unwrap();
        log.actions += 1;
        log.deadlines.push(deadline);
        Ok(())
    }
    fn release(&mut self, plan: &ReleasePlan) -> Result<(), InputError> {
        if self.1.load(Ordering::SeqCst) {
            return Err(InputError::PermissionDenied);
        }
        self.0
            .lock()
            .unwrap()
            .released
            .extend(plan.keys.iter().cloned());
        Ok(())
    }
}
fn signed(body: &Value) -> SignedEnvelope {
    let hex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    let seed: Vec<u8> = hex
        .as_bytes()
        .chunks(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(body).unwrap());
    SignedEnvelope {
        format: "rc-signed-v1".into(),
        key_id: "fixture-only".into(),
        signature: URL_SAFE_NO_PAD.encode(
            key.sign(format!("{DOMAIN}\nfixture-only\n{payload}").as_bytes())
                .to_bytes(),
        ),
        payload,
    }
}
struct Fixture {
    host: HostRuntime,
    body: Value,
    proof: SignedEnvelope,
    ms: u64,
    now: Instant,
    log: Arc<Mutex<Log>>,
    permission: Arc<AtomicBool>,
    release_fails: Arc<AtomicBool>,
}
fn fixture(scope: &str) -> Fixture {
    let f: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/remote-control-native-approval-v1.json"
    ))
    .unwrap();
    let keys = PinnedKeys::new(vec![
        serde_json::from_value::<PinnedKey>(f["key"].clone()).unwrap()
    ])
    .unwrap();
    let ms = f["now"].as_u64().unwrap();
    let now = Instant::now();
    let approval: SignedEnvelope = serde_json::from_value(f["approval"].clone()).unwrap();
    let (state, response) = approve_harness_fixture(
        &keys,
        &approval,
        if scope == "view" {
            Decision::View
        } else {
            Decision::Control
        },
        ms,
        now,
    )
    .unwrap();
    let serialized = serde_json::to_value(response).unwrap();
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(serialized["consent"]["payload"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let body = json!({"protocolVersion":1,"issuer":"todesk-remote-control","audience":"todesk-remote-peer","purpose":"connection",
        "sessionId":claims["sessionId"],"host":claims["host"],"controller":claims["controller"],"negotiationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "hostFingerprint":"AB".repeat(32),"controllerFingerprint":"CD".repeat(32),"consentNonce":claims["consentNonce"],"screenId":"primary",
        "scope":scope,"authorizationRevision":1,"controlEpoch":1,"issuedAt":ms,"expiresAt":ms+30000});
    let proof = signed(&body);
    let geometry = super::super::media_layout::fixture();
    let log = Arc::new(Mutex::new(Log {
        display: Some(geometry.geometry.display_snapshot()),
        layout: Some(geometry),
        ..Log::default()
    }));
    let permission = Arc::new(AtomicBool::new(true));
    let flag = permission.clone();
    let release_fails = Arc::new(AtomicBool::new(false));
    let host = HostRuntime::connect(
        Arc::new(Mutex::new(state)),
        keys,
        &proof,
        ObservedTransport {
            negotiation_id: body["negotiationId"].as_str().unwrap().into(),
            host_fingerprint: "AB".repeat(32),
            controller_fingerprint: "CD".repeat(32),
        },
        Box::new(Driver(log.clone())),
        Box::new(Sink(log.clone(), release_fails.clone())),
        Box::new(move || Availability {
            capture: flag.load(Ordering::SeqCst),
            input: true,
        }),
        1,
        ms,
        now,
    )
    .unwrap();
    Fixture {
        host,
        body,
        proof,
        ms,
        now,
        log,
        permission,
        release_fails,
    }
}
fn hello(f: &mut Fixture) {
    let message = json!({"version":1,"sessionId":f.body["sessionId"],"negotiationId":f.body["negotiationId"],"connectionGeneration":f.body["controller"]["generation"],"type":"hello","payload":{"proof":f.proof}});
    f.host
        .state_message(&serde_json::to_vec(&message).unwrap(), f.now)
        .unwrap();
}
#[test]
fn view_media_does_not_require_input_permission_but_control_does() {
    let mut view = fixture("view");
    view.host.probe = Box::new(|| Availability { capture: true, input: false });
    start(&mut view, "view", 7000);
    assert!(view.host.media_started());
    assert!(view.host.tick(view.now + Duration::from_millis(100)).is_ok());
    assert_eq!(view.log.lock().unwrap().actions, 0);

    let mut control = fixture("control");
    control.host.probe = Box::new(|| Availability { capture: true, input: false });
    assert!(control.host.tick(control.now).is_err());
    assert!(control.host.ended());
    assert_eq!(control.log.lock().unwrap().starts, 0);
    assert_eq!(control.log.lock().unwrap().actions, 0);
}
#[test]
fn queued_controller_heartbeat_retains_native_receipt_time() {
    let mut f = fixture("view");
    hello(&mut f);
    let now = f.now;
    let ms = f.ms;
    lease(&mut f, "view", 1, 1, 15000, now, ms);
    let message = json!({"version":1,"sessionId":f.body["sessionId"],"negotiationId":f.body["negotiationId"],"connectionGeneration":f.body["controller"]["generation"],"type":"heartbeat","payload":{"renderedFrames":0}});
    let receipt = f.now + Duration::from_millis(500);
    let processed = f.now + Duration::from_secs(2);
    // Independent supervisor/lease updates can be newer than queued receipt.
    f.host.supervisor_heartbeat(processed).unwrap();
    f.host
        .state_message_received(&serde_json::to_vec(&message).unwrap(), receipt, processed)
        .unwrap();
    assert_eq!(f.host.last_controller, receipt);
    f.host
        .supervisor_heartbeat(f.now + Duration::from_millis(2900))
        .unwrap();
    assert!(f.host.tick(receipt + Duration::from_secs(3)).is_err());
    assert!(f.host.ended());
}
#[test]
fn expired_or_future_channel_receipt_is_terminal() {
    for age in [Some(Duration::from_secs(3)), None] {
        let mut f = fixture("view");
        hello(&mut f);
        let received = if age.is_some() {
            f.now
        } else {
            f.now + Duration::from_secs(1)
        };
        let processed = f.now + age.unwrap_or_default();
        assert_eq!(
            f.host.state_message_received(b"{}", received, processed),
            Err("REMOTE_CHANNEL_EXPIRED")
        );
        assert!(f.host.ended());
    }
}
fn lease(f: &mut Fixture, scope: &str, revision: u64, epoch: u64, ttl: u64, at: Instant, ms: u64) {
    let challenge = f.host.challenge(at).unwrap();
    let mut body = f.body.clone();
    body["purpose"] = "lease".into();
    body["scope"] = scope.into();
    body["authorizationRevision"] = revision.into();
    body["controlEpoch"] = epoch.into();
    body["leaseSeq"] = challenge.lease_seq.into();
    body["challenge"] = challenge.challenge.into();
    body["issuedAt"] = ms.into();
    body["expiresAt"] = (ms + ttl).into();
    f.host.accept_lease(&signed(&body), ms, at).unwrap();
}
fn start(f: &mut Fixture, scope: &str, ttl: u64) {
    hello(f);
    let now = f.now;
    let ms = f.ms;
    lease(f, scope, 1, 1, ttl, now, ms);
    f.log.lock().unwrap().progress = NativeMediaProgress::at(1, now);
    rendered(f, 1, now);
}
fn rendered(f: &mut Fixture, frames: u64, now: Instant) {
    let message = json!({"version":1,"sessionId":f.body["sessionId"],"negotiationId":f.body["negotiationId"],"connectionGeneration":f.body["controller"]["generation"],"type":"heartbeat","payload":{"renderedFrames":frames}});
    f.host
        .state_message(&serde_json::to_vec(&message).unwrap(), now)
        .unwrap();
}
fn key_down(f: &mut Fixture) {
    let context = f.host.arm_input(f.now).unwrap();
    let window = f.host.input_window(f.now).unwrap();
    let message = json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,
        "layoutVersion":context.layout_version,"seq":1,"inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}});
    f.host
        .input(&serde_json::to_vec(&message).unwrap(), f.now)
        .unwrap();
}
#[test]
fn real_signed_local_consent_connection_hello_and_lease_precede_media() {
    let mut f = fixture("view");
    assert_eq!(f.log.lock().unwrap().starts, 0);
    assert_eq!(
        f.host.challenge(f.now).err(),
        Some("REMOTE_TRANSPORT_NOT_READY")
    );
    hello(&mut f);
    assert_eq!(f.log.lock().unwrap().starts, 0);
    let at = f.now;
    let ms = f.ms;
    lease(&mut f, "view", 1, 1, 7000, at, ms);
    assert!(f.host.media_started());
    assert_eq!(f.log.lock().unwrap().starts, 1);
    assert!(f.host.arm_input(at).is_err());
    assert_eq!(f.log.lock().unwrap().actions, 0);
}
#[test]
fn mismatched_hello_proof_never_starts_media_and_closes_the_driver() {
    let mut f = fixture("view");
    let mut proof = f.proof.clone();
    proof.signature = URL_SAFE_NO_PAD.encode([0u8; 64]);
    let message = json!({"version":1,"sessionId":f.body["sessionId"],"negotiationId":f.body["negotiationId"],"connectionGeneration":1,"type":"hello","payload":{"proof":proof}});
    assert!(f
        .host
        .state_message(&serde_json::to_vec(&message).unwrap(), f.now)
        .is_err());
    assert!(f.host.ended());
    let log = f.log.lock().unwrap();
    assert_eq!(log.starts, 0);
    assert_eq!(log.terminates, 1);
}
#[test]
fn signed_downgrade_releases_only_injected_state_and_updates_local_view_authority() {
    let mut f = fixture("control");
    start(&mut f, "control", 7000);
    key_down(&mut f);
    let at = f.now + Duration::from_millis(100);
    let ms = f.ms + 100;
    lease(&mut f, "view", 2, 2, 7000, at, ms);
    assert_eq!(f.log.lock().unwrap().released, vec!["KeyA"]);
    assert!(f.host.arm_input(at).is_err());
    assert!(f.host.media_started());
    let local = f
        .host
        .identity
        .lock()
        .unwrap()
        .approved_for_runtime(at)
        .unwrap()
        .0;
    assert_eq!(local.scope, Scope::View);
    assert_eq!(local.control_epoch, 2);
    assert_eq!(f.log.lock().unwrap().renews, 1);
}
#[test]
fn pause_keeps_view_media_and_renewal_but_does_not_rearm_old_control_epoch() {
    let mut f = fixture("control");
    start(&mut f, "control", 7000);
    key_down(&mut f);
    f.host.pause(StopReason::LocalStop).unwrap();
    assert!(f.host.media_started());
    assert_eq!(f.log.lock().unwrap().stops, 0);
    assert!(f.host.arm_input(f.now).is_err());
    let at = f.now + Duration::from_millis(100);
    let ms = f.ms + 100;
    lease(&mut f, "control", 1, 1, 7000, at, ms);
    assert_eq!(f.log.lock().unwrap().renews, 1);
    assert!(f.host.arm_input(at).is_err());
}
#[test]
fn logout_permission_loss_and_missing_heartbeats_stop_without_more_input() {
    for mode in 0..3 {
        let mut f = fixture("control");
        start(&mut f, "control", 7000);
        key_down(&mut f);
        let at = match mode {
            0 => {
                f.host.identity.lock().unwrap().stop();
                f.now
            }
            1 => {
                f.permission.store(false, Ordering::SeqCst);
                f.now
            }
            _ => f.now + Duration::from_secs(3),
        };
        assert!(f.host.tick(at).is_err());
        assert!(f.host.ended());
        assert!(!f.host.media_started());
        let log = f.log.lock().unwrap();
        assert_eq!(log.released, vec!["KeyA"]);
        assert_eq!(log.terminates, 1);
    }
}
#[test]
fn failed_release_stops_media_and_retains_ledger_for_retry() {
    let mut f = fixture("control");
    start(&mut f, "control", 7000);
    key_down(&mut f);
    f.release_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        f.host.stop(StopReason::LocalStop),
        Err("REMOTE_INPUT_RELEASE_FAILED")
    );
    assert!(f.host.ended());
    assert!(f.host.pending_release.keys.contains("KeyA"));
    assert_eq!(f.log.lock().unwrap().terminates, 1);
    f.release_fails.store(false, Ordering::SeqCst);
    f.host.tick(f.now).unwrap();
    assert!(f.host.pending_release.keys.is_empty());
    assert_eq!(f.log.lock().unwrap().released, vec!["KeyA"]);
}
#[test]
fn independent_watchdog_expires_media_without_ui_or_input_events() {
    let mut f = fixture("view");
    start(&mut f, "view", 250);
    let log = f.log.clone();
    let mut supervisor = HostSupervisor::spawn(f.host);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && !supervisor.runtime().lock().unwrap().ended() {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(supervisor.runtime().lock().unwrap().ended());
    assert_eq!(log.lock().unwrap().terminates, 1);
    supervisor.stop(StopReason::LocalStop).unwrap();
}
#[test]
fn desktop_stop_drains_the_real_supervisor_and_local_consent() {
    let mut f = fixture("control");
    start(&mut f, "control", 7000);
    key_down(&mut f);
    let state = super::super::RemoteControlState {
        engine_ready: std::sync::OnceLock::new(),
        consent_memory_epoch: Default::default(),
        identity: f.host.identity.clone(),
        host: Mutex::new(Some(HostSupervisor::spawn(f.host))),
        bridge: Mutex::new(None),
    };
    state.stop().unwrap();
    assert_eq!(f.log.lock().unwrap().released, vec!["KeyA"]);
    assert!(state.host.lock().unwrap().is_none());
}

#[test]
fn ended_watchdog_retries_unconfirmed_process_exit() {
    let mut f = fixture("view");
    start(&mut f, "view", 7000);
    f.log.lock().unwrap().terminate_failures = 1;
    assert!(f.host.stop(StopReason::LocalStop).is_err());
    assert!(f.host.ended());
    assert!(!f.host.process_terminated);
    f.host.tick(f.now + Duration::from_millis(100)).unwrap();
    assert!(f.host.process_terminated);
    assert_eq!(f.log.lock().unwrap().terminates, 2);
}

#[test]
fn state_payload_duplicate_keys_are_terminal() {
    let mut f = fixture("view");
    hello(&mut f);
    let message = json!({"version":1,"sessionId":f.body["sessionId"],"negotiationId":f.body["negotiationId"],"connectionGeneration":f.body["controller"]["generation"],"type":"heartbeat","payload":{"renderedFrames":1}});
    let bytes = serde_json::to_string(&message).unwrap().replace(
        "\"renderedFrames\":1",
        "\"renderedFrames\":1,\"renderedFrames\":2",
    );
    assert!(f.host.state_message(bytes.as_bytes(), f.now).is_err());
    assert!(f.host.ended());
}

#[test]
fn missing_native_or_rendered_first_frame_never_arms_control() {
    let mut f = fixture("control");
    hello(&mut f);
    let at = f.now;
    let ms = f.ms;
    lease(&mut f, "control", 1, 1, 15000, at, ms);
    assert_eq!(f.host.arm_input(at), Err("REMOTE_MEDIA_NOT_LIVE"));
    rendered(&mut f, 1, at);
    assert_eq!(f.host.arm_input(at), Err("REMOTE_MEDIA_NOT_LIVE"));
    f.log.lock().unwrap().progress = NativeMediaProgress::at(1, at);
    assert!(f.host.arm_input(at).is_ok());
    assert_eq!(f.log.lock().unwrap().actions, 0);
}

#[test]
fn every_frozen_stage_pauses_and_ends_even_with_other_progress_and_lease_renewal() {
    use super::super::media_liveness::MediaStage;
    for frozen in 0..4 {
        let mut f = fixture("control");
        start(&mut f, "control", 15000);
        key_down(&mut f);
        let stage = [
            MediaStage::Capture,
            MediaStage::Encoded,
            MediaStage::Forwarded,
            MediaStage::Rendered,
        ][frozen];
        for seconds in 1..=9 {
            let at = f.now + Duration::from_secs(seconds);
            {
                let mut log = f.log.lock().unwrap();
                for native in 0..3 {
                    if native != frozen {
                        log.progress.set_stage(native, seconds + 1, at);
                    }
                }
            }
            f.host.supervisor_heartbeat(at).unwrap();
            rendered(&mut f, if frozen == 3 { 1 } else { seconds + 1 }, at);
            f.host.tick(at).unwrap();
            if seconds == 4 || seconds == 8 {
                let ms = f.ms + seconds * 1000;
                lease(&mut f, "control", 1, 1, 15000, at, ms);
            }
            if seconds >= 3 {
                assert_eq!(
                    f.host.media_health(),
                    MediaHealth {
                        status: MediaStatus::Stalled,
                        stage: Some(stage)
                    }
                );
                assert!(f.host.paused);
                assert!(f.host.media_started());
                assert!(!f.host.ended());
                assert!(f.host.arm_input(at).is_err());
                assert_eq!(f.log.lock().unwrap().released, vec!["KeyA"]);
            }
        }
        assert_eq!(f.log.lock().unwrap().renews, 2);
        let at = f.now + Duration::from_secs(10);
        assert_eq!(f.host.tick(at), Err("REMOTE_MEDIA_FROZEN"));
        assert_eq!(f.host.stop_reason(), Some(StopReason::MediaStalled));
        assert!(!f.host.media_started());
        assert_eq!(f.log.lock().unwrap().terminates, 1);
    }
}

#[test]
fn recovered_capture_cannot_automatically_rearm_the_paused_control_epoch() {
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    key_down(&mut f);
    for seconds in 1..=3 {
        let at = f.now + Duration::from_secs(seconds);
        {
            let mut log = f.log.lock().unwrap();
            for stage in 1..3 {
                log.progress.set_stage(stage, seconds + 1, at);
            }
        }
        f.host.supervisor_heartbeat(at).unwrap();
        rendered(&mut f, seconds + 1, at);
    }
    assert!(f.host.paused);
    let at = f.now + Duration::from_secs(4);
    f.log.lock().unwrap().progress = NativeMediaProgress::at(8, at);
    f.host.supervisor_heartbeat(at).unwrap();
    rendered(&mut f, 8, at);
    assert_eq!(f.host.media_health().status, MediaStatus::Healthy);
    assert_eq!(f.host.arm_input(at), Err("REMOTE_CONTROL_NOT_ALLOWED"));
    let ms = f.ms + 4000;
    lease(&mut f, "control", 1, 1, 15000, at, ms);
    assert!(f.host.arm_input(at).is_err());
    assert!(!f.host.ended());
    assert_eq!(f.log.lock().unwrap().released, vec!["KeyA"]);
}

#[test]
fn input_post_deadline_includes_media_liveness_even_before_watchdog_tick() {
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    let at = f.now + Duration::from_millis(2900);
    f.host.supervisor_heartbeat(at).unwrap();
    rendered(&mut f, 2, at);
    let context = f.host.arm_input(at).unwrap();
    let window = f.host.input_window(at).unwrap();
    let message = json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":1,"inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}});
    f.host
        .input(&serde_json::to_vec(&message).unwrap(), at)
        .unwrap();
    assert_eq!(
        f.log.lock().unwrap().deadlines,
        vec![f.now + Duration::from_secs(3)]
    );
    let at = f.now + Duration::from_secs(3);
    assert_eq!(
        f.host
            .input(&serde_json::to_vec(&message).unwrap(), at)
            .err(),
        Some("REMOTE_MEDIA_NOT_LIVE")
    );
    assert_eq!(f.log.lock().unwrap().actions, 1);
    assert_eq!(f.log.lock().unwrap().released, vec!["KeyA"]);
    assert!(!f.host.ended());
}

#[test]
fn in_flight_input_after_freeze_is_discarded_without_ack_or_early_view_end() {
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    let context = f.host.arm_input(f.now).unwrap();
    let window = f.host.input_window(f.now).unwrap();
    let message=serde_json::to_vec(&json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":1,"inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}})).unwrap();
    for seconds in 1..=9 {
        let at = f.now + Duration::from_secs(seconds);
        {
            let mut log = f.log.lock().unwrap();
            for stage in 1..3 {
                log.progress.set_stage(stage, seconds + 1, at);
            }
        }
        f.host.supervisor_heartbeat(at).unwrap();
        rendered(&mut f, seconds + 1, at);
        if seconds >= 3 {
            let channels = f.log.lock().unwrap().channels.len();
            f.host.input_message(&message, at).unwrap();
            assert_eq!(
                f.log.lock().unwrap().channels.len(),
                channels,
                "discarded input must not ACK"
            );
            assert_eq!(f.log.lock().unwrap().actions, 0);
            assert!(f.host.paused);
            assert!(f.host.media_started());
            assert!(!f.host.ended());
        }
    }
    assert_eq!(
        f.host.tick(f.now + Duration::from_secs(10)),
        Err("REMOTE_MEDIA_FROZEN")
    );
    assert_eq!(f.host.stop_reason(), Some(StopReason::MediaStalled));
}

#[test]
fn invalid_input_while_paused_still_terminates_the_session() {
    for mismatch in [
        "malformed",
        "sessionId",
        "controlEpoch",
        "inputEpoch",
        "layoutVersion",
    ] {
        let mut f = fixture("control");
        start(&mut f, "control", 15000);
        let context = f.host.arm_input(f.now).unwrap();
        let window = f.host.input_window(f.now).unwrap();
        let mut message = json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":1,"inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}});
        let bytes = match mismatch {
            "malformed" => b"{malformed".to_vec(),
            "sessionId" => {
                message[mismatch] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into();
                serde_json::to_vec(&message).unwrap()
            }
            _ => {
                message[mismatch] = (message[mismatch].as_u64().unwrap() + 1).into();
                serde_json::to_vec(&message).unwrap()
            }
        };
        f.host.pause(StopReason::MediaStalled).unwrap();
        assert_eq!(
            f.host.input_message(&bytes, f.now),
            Err("REMOTE_INPUT_REJECTED"),
            "{mismatch}"
        );
        assert!(f.host.ended());
        assert!(!f.host.media_started());
        assert_eq!(f.log.lock().unwrap().actions, 0);
    }
}

#[test]
fn pause_discards_previously_issued_epoch_after_blur_and_rearm() {
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    let first = f.host.arm_input(f.now).unwrap();
    let first_window = f.host.input_window(f.now).unwrap();
    f.host.release_input(StopReason::LocalStop).unwrap();
    let second = f.host.arm_input(f.now).unwrap();
    let second_window = f.host.input_window(f.now).unwrap();
    assert!(second.input_epoch > first.input_epoch);
    f.host.pause(StopReason::MediaStalled).unwrap();
    let channel_count = f.log.lock().unwrap().channels.len();
    for (context, window) in [(first, first_window), (second, second_window)] {
        let message=serde_json::to_vec(&json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":1,"inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}})).unwrap();
        f.host.input_message(&message, f.now).unwrap();
        assert!(f.host.media_started());
        assert!(!f.host.ended());
    }
    let log = f.log.lock().unwrap();
    assert_eq!(log.channels.len(), channel_count);
    assert_eq!(log.actions, 0);
}

#[test]
fn crossing_liveness_deadline_inside_executor_pauses_without_ending_view() {
    struct CrossDeadline;
    impl InputExecutor for CrossDeadline {
        fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
            Ok(super::super::media_layout::fixture()
                .geometry
                .display_snapshot())
        }
        fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
            Ok(InputEnvironment {
                screen_id: "primary".into(),
                layout_version: 1,
            })
        }
        fn execute(&mut self, _: &InputAction, deadline: Instant) -> Result<(), InputError> {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(remaining <= Duration::from_millis(250));
            thread::sleep(remaining + Duration::from_millis(2));
            Err(InputError::Expired)
        }
        fn release(&mut self, _: &ReleasePlan) -> Result<(), InputError> {
            Ok(())
        }
    }
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    let now = Instant::now();
    f.host.liveness = MediaLiveness::default();
    f.host
        .liveness
        .start(now - Duration::from_secs(3), NativeMediaProgress::default())
        .unwrap();
    f.log.lock().unwrap().progress = NativeMediaProgress::at(1, now - Duration::from_millis(2800));
    f.host.liveness.rendered(1, now).unwrap();
    f.host.input = Box::new(CrossDeadline);
    let context = f.host.arm_input(now).unwrap();
    let window = f.host.input_window(now).unwrap();
    let message=serde_json::to_vec(&json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":1,"inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}})).unwrap();
    f.host.input_message(&message, now).unwrap();
    assert!(f.host.paused);
    assert!(f.host.media_started());
    assert!(!f.host.ended());
    assert!(!f
        .log
        .lock()
        .unwrap()
        .channels
        .iter()
        .any(|message| message["type"] == "input-ack"));
    assert_eq!(f.log.lock().unwrap().actions, 0);
}

#[test]
fn final_heartbeat_or_challenge_after_real_lease_expiry_is_normal_completion() {
    for operation in 0..3 {
        let mut f = fixture("view");
        start(&mut f, "view", 250);
        assert!(!f.host.expected_terminal_error("REMOTE_AUTHORITY_EXPIRED"));
        let at = f.now + Duration::from_millis(250);
        let result = match operation {
            0 => f.host.controller_heartbeat(at),
            1 => f.host.supervisor_heartbeat(at),
            _ => f.host.challenge(at).map(|_| ()),
        };
        assert_eq!(result, Err("REMOTE_AUTHORITY_EXPIRED"));
        assert_eq!(f.host.stop_reason(), Some(StopReason::LeaseExpired));
        assert!(f.host.expected_terminal_error(result.unwrap_err()));
        assert_eq!(f.host.challenge(at).err(), Some("REMOTE_SESSION_ENDED"));
        assert!(f.host.expected_terminal_error("REMOTE_SESSION_ENDED"));
        for abnormal in [
            "REMOTE_IPC_REJECTED",
            "REMOTE_ENGINE_FAILED",
            "INVALID_REMOTE_LEASE",
            "REMOTE_MEDIA_FROZEN",
        ] {
            assert!(!f.host.expected_terminal_error(abnormal));
        }
    }
}

#[test]
fn engine_exit_at_verified_expiry_is_normal_but_premature_exit_remains_failure() {
    for expired in [false, true] {
        let mut f = fixture("view");
        start(&mut f, "view", 250);
        f.log.lock().unwrap().unhealthy = true;
        let at = f.now + Duration::from_millis(if expired { 250 } else { 249 });
        assert_eq!(
            f.host.supervisor_heartbeat(at),
            Err("REMOTE_AUTHORITY_EXPIRED")
        );
        assert_eq!(
            f.host.stop_reason(),
            Some(if expired {
                StopReason::LeaseExpired
            } else {
                StopReason::SystemUnavailable
            })
        );
        assert_eq!(
            f.host.expected_terminal_error("REMOTE_AUTHORITY_EXPIRED"),
            expired
        );
        assert_eq!(
            f.host.expected_terminal_error("REMOTE_SESSION_ENDED"),
            expired
        );
    }
}

#[test]
fn media_without_trusted_geometry_cannot_arm_until_verified_layout_arrives() {
    let mut f = fixture("control");
    f.log.lock().unwrap().layout = None;
    start(&mut f, "control", 15000);
    assert!(f.host.media_started());
    assert_eq!(f.host.arm_input(f.now), Err("REMOTE_MEDIA_LAYOUT_REQUIRED"));
    assert!(!f
        .log
        .lock()
        .unwrap()
        .channels
        .iter()
        .any(|v| v["type"] == "layout"));
    let layout = super::super::media_layout::fixture();
    f.log.lock().unwrap().layout = Some(layout.clone());
    f.host.tick(f.now).unwrap();
    assert!(f.host.arm_input(f.now).is_ok());
    let log = f.log.lock().unwrap();
    let state = log.channels.iter().find(|v| v["type"] == "layout").unwrap();
    assert_eq!(state["payload"], serde_json::to_value(layout).unwrap());
    assert_eq!(log.actions, 0);
}

#[test]
fn capture_geometry_change_or_native_snapshot_mismatch_releases_and_stops() {
    for mode in 0..8 {
        let mut f = fixture("control");
        start(&mut f, "control", 15000);
        key_down(&mut f);
        {
            let mut log = f.log.lock().unwrap();
            match mode {
                0 => log.layout.as_mut().unwrap().geometry.content_rect.width = 1200.0,
                1 => log.layout.as_mut().unwrap().layout_version = 2,
                2 => log.layout.as_mut().unwrap().geometry.encoded_size.width = 1300,
                3 => log.display.as_mut().unwrap().display_id = 2,
                4 => log.display.as_mut().unwrap().bounds.x = -1920.0,
                5 => log.display.as_mut().unwrap().pixels.width = 1920,
                6 => {
                    log.display.as_mut().unwrap().rotation_degrees = 180;
                    log.layout.as_mut().unwrap().geometry.rotation_degrees = 180;
                }
                _ => {
                    log.layout_failed = true;
                    log.unhealthy = true;
                }
            }
        }
        assert!(f.host.tick(f.now).is_err());
        assert!(f.host.ended());
        assert!(!f.host.media_started());
        assert_eq!(f.host.stop_reason(), Some(StopReason::LayoutChanged));
        let log = f.log.lock().unwrap();
        assert_eq!(log.released, vec!["KeyA"]);
        assert_eq!(log.terminates, 1);
    }
}

#[test]
fn authenticated_layout_is_not_forwarded_before_the_first_verified_lease() {
    let mut f = fixture("view");
    hello(&mut f);
    assert!(!f
        .log
        .lock()
        .unwrap()
        .channels
        .iter()
        .any(|v| v["type"] == "layout"));
    let now = f.now;
    let ms = f.ms;
    lease(&mut f, "view", 1, 1, 15000, now, ms);
    assert_eq!(
        f.log
            .lock()
            .unwrap()
            .channels
            .iter()
            .filter(|v| v["type"] == "layout")
            .count(),
        1
    );
}

#[test]
fn layout_change_during_input_preflight_never_reaches_executor_or_ack() {
    struct ChangingSink {
        log: Arc<Mutex<Log>>,
        preflights: u8,
    }
    impl InputExecutor for ChangingSink {
        fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
            Ok(self.log.lock().unwrap().display.unwrap())
        }
        fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
            self.preflights += 1;
            if self.preflights == 2 {
                self.log
                    .lock()
                    .unwrap()
                    .layout
                    .as_mut()
                    .unwrap()
                    .geometry
                    .content_rect
                    .width = 1200.0;
            }
            Ok(InputEnvironment {
                screen_id: "primary".into(),
                layout_version: 1,
            })
        }
        fn execute(&mut self, _: &InputAction, _: Instant) -> Result<(), InputError> {
            self.log.lock().unwrap().actions += 1;
            Ok(())
        }
        fn release(&mut self, plan: &ReleasePlan) -> Result<(), InputError> {
            self.log
                .lock()
                .unwrap()
                .released
                .extend(plan.keys.iter().cloned());
            Ok(())
        }
    }
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    key_down(&mut f);
    let context = f.host.guard.context().unwrap();
    let window = f.host.input_window(f.now).unwrap();
    f.host.input = Box::new(ChangingSink {
        log: f.log.clone(),
        preflights: 0,
    });
    let bytes=serde_json::to_vec(&json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,"inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":2,"inputWindowId":window.input_window_id,"type":"move","payload":{"x":0.5,"y":0.5}})).unwrap();
    assert_eq!(
        f.host.input_message(&bytes, f.now),
        Err("REMOTE_INPUT_REJECTED")
    );
    assert_eq!(f.host.stop_reason(), Some(StopReason::LayoutChanged));
    assert!(f.host.ended());
    let log = f.log.lock().unwrap();
    assert_eq!(log.actions, 1);
    assert_eq!(log.released, vec!["KeyA"]);
    assert!(!log.channels.iter().any(|v| v["type"] == "input-ack"));
}

#[test]
fn expired_input_window_releases_keys_without_ending_authorized_screen_stream() {
    let mut f = fixture("control");
    start(&mut f, "control", 15000);
    let context = f.host.arm_input(f.now).unwrap();
    let window = f.host.input_window(f.now).unwrap();
    let mut message = json!({"version":1,"sessionId":context.session_id,"controlEpoch":context.control_epoch,
        "inputEpoch":context.input_epoch,"layoutVersion":context.layout_version,"seq":1,
        "inputWindowId":window.input_window_id,"type":"key","payload":{"code":"KeyA","down":true}});
    f.host.input_message(&serde_json::to_vec(&message).unwrap(), f.now).unwrap();
    message["seq"] = 2.into();
    message["payload"]["code"] = "KeyB".into();
    let before = f.log.lock().unwrap().channels.iter().filter(|m| m["type"] == "input-ack").count();
    let at = f.now + Duration::from_millis(501);
    f.host.input_message(&serde_json::to_vec(&message).unwrap(), at).unwrap();
    assert!(!f.host.ended());
    assert!(f.host.media_started());
    assert!(f.host.paused);
    assert_eq!(f.host.arm_input(at).err(), Some("REMOTE_CONTROL_NOT_ALLOWED"));
    // In-flight old input remains discarded while paused, without acknowledging it.
    f.host.input_message(&serde_json::to_vec(&message).unwrap(), at).unwrap();
    let log = f.log.lock().unwrap();
    assert_eq!(log.actions, 1);
    assert_eq!(log.released, vec!["KeyA"]);
    assert_eq!(log.channels.iter().filter(|m| m["type"] == "input-ack").count(), before);
    assert!(log.channels.iter().any(|m| m["type"] == "pause"));
}
