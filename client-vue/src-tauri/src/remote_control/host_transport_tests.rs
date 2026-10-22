use super::super::{
    authorization::{PinnedKey, VerifiedLease, DOMAIN},
    guard::ReleasePlan,
    host_runtime::Availability,
    identity::{approve_harness_fixture, Decision},
    input::{InputAction, InputEnvironment, InputError},
    media_layout::{DisplaySnapshot, MediaLayout},
    media_liveness::NativeMediaProgress,
};
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use std::sync::atomic::{AtomicUsize, Ordering};
const NEGOTIATION: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

struct Fixture {
    identity: Arc<Mutex<IdentityState>>,
    keys: PinnedKeys,
    proof: SignedEnvelope,
    ms: u64,
    now: Instant,
}
fn fixture() -> Fixture {
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
    let (state, response) = approve_harness_fixture(
        &keys,
        &serde_json::from_value(f["approval"].clone()).unwrap(),
        Decision::View,
        ms,
        now,
    )
    .unwrap();
    let response = serde_json::to_value(response).unwrap();
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(response["consent"]["payload"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let body = json!({"protocolVersion":1,"issuer":"todesk-remote-control","audience":"todesk-remote-peer","purpose":"connection",
        "sessionId":claims["sessionId"],"host":claims["host"],"controller":claims["controller"],"negotiationId":NEGOTIATION,
        "hostFingerprint":"AB".repeat(32),"controllerFingerprint":"CD".repeat(32),"consentNonce":claims["consentNonce"],"screenId":"primary",
        "scope":"view","authorizationRevision":1,"controlEpoch":1,"issuedAt":ms,"expiresAt":ms+30000});
    let seed: Vec<u8> = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
        .as_bytes()
        .chunks(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&body).unwrap());
    let proof = SignedEnvelope {
        format: "rc-signed-v1".into(),
        key_id: "fixture-only".into(),
        signature: URL_SAFE_NO_PAD.encode(
            key.sign(format!("{DOMAIN}\nfixture-only\n{payload}").as_bytes())
                .to_bytes(),
        ),
        payload,
    };
    Fixture {
        identity: Arc::new(Mutex::new(state)),
        keys,
        proof,
        ms,
        now,
    }
}
fn event(kind: &str, payload: Value) -> IpcMessage {
    IpcMessage {
        kind: kind.into(),
        payload,
        received_at: Instant::now(),
    }
}
fn sdp(octet: &str) -> String {
    format!(
        "v=0\r\na=fingerprint:sha-256 {}\r\n",
        vec![octet; 32].join(":")
    )
}
fn observe(t: &mut HostTransport, kind: &str, value: Value, now: Instant) -> HostResult<()> {
    let mut event = event(kind, value);
    event.received_at = now;
    t.observe(&event, now, false)
}
fn negotiate(f: &Fixture) -> HostTransport {
    let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    observe(
        &mut t,
        "ready",
        json!({"mediaStarted":false,"loopbackOnly":true}),
        f.now,
    )
    .unwrap();
    t.offer(NEGOTIATION, &sdp("CD"), f.now).unwrap();
    observe(&mut t, "answer", json!({"sdp":sdp("AB")}), f.now).unwrap();
    observe(
        &mut t,
        "dtls",
        json!({"hostFingerprint":"AB".repeat(32),"controllerFingerprint":"CD".repeat(32)}),
        f.now,
    )
    .unwrap();
    t
}
struct Driver(Arc<AtomicUsize>);
impl MediaDriver for Driver {
    fn start_media(&mut self, _: &VerifiedLease, _: Instant) -> HostResult<()> {
        panic!("negotiation must not capture")
    }
    fn renew_media(&mut self, _: &VerifiedLease, _: Instant) -> HostResult<()> {
        panic!("negotiation must not capture")
    }
    fn stop_media(&mut self) -> HostResult<()> {
        Ok(())
    }
    fn terminate(&mut self) -> HostResult<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn send_channel(&mut self, _: &str, _: &[u8]) -> HostResult<()> {
        Ok(())
    }
    fn healthy(&self) -> bool {
        true
    }
    fn media_progress(&self) -> HostResult<NativeMediaProgress> {
        Ok(NativeMediaProgress::default())
    }
    fn media_layout(&self) -> HostResult<Option<MediaLayout>> {
        Ok(None)
    }
}
struct Sink;
impl InputExecutor for Sink {
    fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
        Err(InputError::LayoutChanged)
    }
    fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
        panic!("no OS input during negotiation")
    }
    fn execute(&mut self, _: &InputAction, _: Instant) -> Result<(), InputError> {
        panic!("no OS input during negotiation")
    }
    fn release(&mut self, _: &ReleasePlan) -> Result<(), InputError> {
        Ok(())
    }
}
fn connect(t: &mut HostTransport, f: &Fixture, log: Arc<AtomicUsize>) -> HostResult<HostRuntime> {
    t.connect(
        f.keys.clone(),
        &f.proof,
        Box::new(Driver(log)),
        Box::new(Sink),
        Box::new(|| Availability {
            capture: true,
            input: true,
        }),
        f.ms,
        f.now,
    )
}

#[test]
fn reserve_before_launch_and_reject_concurrent_use() {
    let empty = Arc::new(Mutex::new(IdentityState::default()));
    assert!(PreparedHost::prepare(empty, Instant::now(), |_| panic!(
        "no consent must not spawn"
    ))
    .is_err());
    let f = fixture();
    let t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    assert!(PreparedHost::prepare(f.identity.clone(), f.now, |_| panic!(
        "duplicate must not spawn"
    ))
    .is_err());
    assert!(t.check(f.now, false).is_ok());
    drop(t);
    assert!(f
        .identity
        .lock()
        .unwrap()
        .approved_for_runtime(f.now)
        .is_err());
}
#[test]
fn failed_spawn_revokes_original_consent() {
    let f = fixture();
    assert!(
        PreparedHost::prepare(f.identity.clone(), f.now, |_| Err("TEST_SPAWN_FAILED")).is_err()
    );
    assert!(f
        .identity
        .lock()
        .unwrap()
        .approved_for_runtime(f.now)
        .is_err());
}
#[cfg(unix)]
#[test]
fn stop_during_launch_reaps_process_before_returning_failure() {
    let f = fixture();
    let pid = Arc::new(AtomicUsize::new(0));
    let observed = pid.clone();
    let state = f.identity.clone();
    let result = PreparedHost::prepare(f.identity.clone(), f.now, |session| {
        let result = ProcessMediaDriver::idle_test_process(session)?;
        observed.store(result.0.pid()? as usize, Ordering::SeqCst);
        state.lock().unwrap().stop();
        Ok(result)
    });
    assert!(matches!(result, Err("REMOTE_OPERATION_CANCELLED")));
    assert!(pid.load(Ordering::SeqCst) > 0);
    assert_ne!(
        unsafe { libc::kill(pid.load(Ordering::SeqCst) as libc::pid_t, 0) },
        0
    );
}
#[test]
fn old_claim_drop_does_not_cancel_new_operation() {
    let f = fixture();
    let t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    let operation = {
        let mut state = f.identity.lock().unwrap();
        state.stop();
        state.begin().unwrap()
    };
    drop(t);
    assert!(f.identity.lock().unwrap().check(operation).is_ok());
}
#[test]
fn offer_does_not_restart_startup_deadline() {
    let f = fixture();
    let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    t.offer(NEGOTIATION, &sdp("CD"), f.now + Duration::from_secs(29))
        .unwrap();
    assert_eq!(
        t.check(f.now + Duration::from_secs(30), false),
        Err("REMOTE_CONNECT_TIMEOUT")
    );
}
#[test]
fn late_connection_after_local_stop_terminates_driver() {
    let f = fixture();
    let mut t = negotiate(&f);
    f.identity.lock().unwrap().stop();
    let terminated = Arc::new(AtomicUsize::new(0));
    assert!(connect(&mut t, &f, terminated.clone()).is_err());
    assert_eq!(terminated.load(Ordering::SeqCst), 1);
}
#[test]
fn connection_consumes_reserved_consent_once_and_needs_native_dtls() {
    let f = fixture();
    let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    let terminated = Arc::new(AtomicUsize::new(0));
    assert!(connect(&mut t, &f, terminated.clone()).is_err());
    assert_eq!(terminated.load(Ordering::SeqCst), 1);
    drop(t);
    let f = fixture();
    let mut t = negotiate(&f);
    let runtime = connect(&mut t, &f, terminated.clone()).unwrap();
    assert!(!runtime.media_started());
    assert!(connect(&mut t, &f, terminated.clone()).is_err());
    drop(runtime);
    assert!(f
        .identity
        .lock()
        .unwrap()
        .approved_for_runtime(f.now)
        .is_err());
}
#[test]
fn mismatched_signed_connection_cannot_start_media() {
    let f = fixture();
    let mut t = negotiate(&f);
    let mut other = fixture();
    other.proof.signature = "A".repeat(86);
    assert!(connect(&mut t, &other, Arc::new(AtomicUsize::new(0))).is_err());
    assert!(f
        .identity
        .lock()
        .unwrap()
        .approved_for_runtime(f.now)
        .is_err());
}
#[test]
fn observed_certificate_must_match_both_sdp_descriptions_and_never_change() {
    let f = fixture();
    let mut t = negotiate(&f);
    for fp in ["EF", "AB"] {
        assert!(observe(
            &mut t,
            "dtls",
            json!({"hostFingerprint":fp.repeat(32),"controllerFingerprint":"CD".repeat(32)}),
            f.now
        )
        .is_err());
    }
    let f = fixture();
    let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    assert!(observe(
        &mut t,
        "dtls",
        json!({"hostFingerprint":"AB".repeat(32),"controllerFingerprint":"CD".repeat(32)}),
        f.now
    )
    .is_err());
}
#[test]
fn sdp_and_ice_reject_ambiguous_or_external_destinations() {
    for invalid in [
        String::new(),
        sdp("CD") + &sdp("AB"),
        sdp("CD") + "a=candidate:1 1 udp 1 192.168.1.1 9999 typ host\r\n",
        sdp("CD").replace("sha-256", "sha-1"),
    ] {
        assert!(sdp_fingerprint(&invalid).is_err());
    }
    for invalid in [
        "candidate:1 1 udp 1 example.com 123 typ host",
        "candidate:1 1 udp 1 127.0.0.1 0 typ host",
        "candidate:1 1 udp 1 127.0.0.1 123 typ relay",
    ] {
        assert!(validate_candidate(invalid).is_err());
    }
    assert_eq!(sdp_fingerprint(&sdp("cd")).unwrap(), "CD".repeat(32));
}
#[test]
fn candidate_limits_are_independent_and_fields_strict() {
    let f = fixture();
    let mut t = negotiate(&f);
    let ice = json!({"candidate":"candidate:1 1 udp 1 127.0.0.1 1234 typ host","sdpMLineIndex":0});
    for _ in 0..128 {
        t.ice(ice.clone(), f.now, false).unwrap();
    }
    assert!(t.ice(ice.clone(), f.now, false).is_err());
    observe(&mut t, "ice", ice.clone(), f.now).unwrap();
    let mut extra = ice.clone();
    extra["path"] = "/tmp/engine".into();
    assert!(validate_ice(&extra, CandidatePolicy::Loopback).is_err());
    let mut wrong = ice;
    wrong["sdpMLineIndex"] = 3.into();
    assert!(validate_ice(&wrong, CandidatePolicy::Loopback).is_err());
}
#[test]
fn channels_require_native_open_both_labels_and_bounded_pending_queue() {
    let f = fixture();
    let mut t = negotiate(&f);
    let packet = json!({"label":"rc-state-v1","data":URL_SAFE_NO_PAD.encode(b"hello")});
    assert!(observe(&mut t, "channel-data", packet.clone(), f.now).is_err());
    observe(
        &mut t,
        "channel-open",
        json!({"label":"rc-state-v1"}),
        f.now,
    )
    .unwrap();
    for _ in 0..32 {
        observe(&mut t, "channel-data", packet.clone(), f.now).unwrap();
    }
    assert!(observe(&mut t, "channel-data", packet, f.now).is_err());
    assert!(t.drain_channels(f.now).unwrap().is_empty());
    let _runtime = connect(&mut t, &f, Arc::new(AtomicUsize::new(0))).unwrap();
    assert!(t.drain_channels(f.now).unwrap().is_empty());
    observe(
        &mut t,
        "channel-open",
        json!({"label":"rc-input-v1"}),
        f.now,
    )
    .unwrap();
    assert_eq!(t.drain_channels(f.now).unwrap().len(), 32);
}
#[test]
fn queued_heartbeat_cannot_gain_a_fresh_deadline_after_stall() {
    let f = fixture();
    let mut t = negotiate(&f);
    for label in ["rc-state-v1", "rc-input-v1"] {
        observe(&mut t, "channel-open", json!({"label":label}), f.now).unwrap();
    }
    observe(
        &mut t,
        "channel-data",
        json!({"label":"rc-state-v1","data":URL_SAFE_NO_PAD.encode(b"heartbeat")}),
        f.now,
    )
    .unwrap();
    let _runtime = connect(&mut t, &f, Arc::new(AtomicUsize::new(0))).unwrap();
    assert_eq!(
        t.drain_channels(f.now + Duration::from_secs(3))
            .unwrap_err(),
        "REMOTE_CHANNEL_EXPIRED"
    );
}

#[test]
fn process_receive_queue_age_is_not_reset_by_transport_poll() {
    let f = fixture();
    let mut t = negotiate(&f);
    observe(
        &mut t,
        "channel-open",
        json!({"label":"rc-state-v1"}),
        f.now,
    )
    .unwrap();
    let mut packet = event(
        "channel-data",
        json!({"label":"rc-state-v1","data":URL_SAFE_NO_PAD.encode(b"heartbeat")}),
    );
    packet.received_at = f.now;
    assert_eq!(
        t.observe(&packet, f.now + Duration::from_secs(3), false),
        Err("REMOTE_CHANNEL_EXPIRED")
    );
    packet.received_at = f.now + Duration::from_secs(1);
    assert_eq!(
        t.observe(&packet, f.now, false),
        Err("REMOTE_CHANNEL_EXPIRED")
    );
}
#[test]
fn replay_and_premature_media_are_rejected() {
    let f = fixture();
    let mut t = negotiate(&f);
    assert!(t.offer(NEGOTIATION, &sdp("CD"), f.now).is_err());
    assert!(observe(&mut t, "answer", json!({"sdp":sdp("AB")}), f.now).is_err());
    assert!(observe(&mut t, "media-started", json!({}), f.now).is_err());
    let _runtime = connect(&mut t, &f, Arc::new(AtomicUsize::new(0))).unwrap();
    assert!(observe(&mut t, "media-started", json!({}), f.now).is_err());
    assert!(observe(&mut t, "channel-open", json!({"label":"arbitrary"}), f.now).is_err());
    assert!(observe(&mut t, "unknown", json!({}), f.now).is_err());
}

fn signed_ice(f: &Fixture, change: impl FnOnce(&mut Value)) -> SignedEnvelope {
    let c: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&f.proof.payload).unwrap()).unwrap();
    let mut body = json!({"protocolVersion":1,"issuer":"todesk-remote-control","audience":"todesk-native-ice","purpose":"ice-config",
        "sessionId":c["sessionId"],"host":c["host"],"controller":c["controller"],"issuedAt":f.ms,
        "sessionExpiresAt":f.ms+3_300_000,"expiresAt":f.ms+3_599_000,"iceTransportPolicy":"relay",
        "iceServers":[{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"1700003599:rc:test","credential":"test-only+/="}]});
    change(&mut body);
    let seed: Vec<u8> = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
        .as_bytes()
        .chunks(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&body).unwrap());
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
#[test]
fn signed_ice_enables_network_once_before_offer_and_requires_engine_ack() {
    let f = fixture();
    let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    let proof = signed_ice(&f, |_| {});
    let payload = t.configure_ice(&f.keys, &proof, f.ms, f.now).unwrap();
    assert_eq!(payload["iceTransportPolicy"], "relay");
    assert!(payload.get("proof").is_none());
    assert!(t.configure_ice(&f.keys, &proof, f.ms, f.now).is_err());
    observe(
        &mut t,
        "ready",
        json!({"mediaStarted":false,"loopbackOnly":true}),
        f.now,
    )
    .unwrap();
    t.offer(NEGOTIATION, &sdp("CD"), f.now).unwrap();
    assert!(observe(&mut t, "answer", json!({"sdp":sdp("AB")}), f.now).is_err());
    observe(
        &mut t,
        "network-configured",
        json!({"iceTransportPolicy":"relay"}),
        f.now,
    )
    .unwrap();
    assert!(observe(
        &mut t,
        "network-configured",
        json!({"iceTransportPolicy":"relay"}),
        f.now
    )
    .is_err());
    observe(&mut t, "answer", json!({"sdp":sdp("AB")}), f.now).unwrap();
    t.ice(json!({"candidate":"candidate:1 1 udp 123 203.0.113.10 40000 typ relay raddr 0.0.0.0 rport 0","sdpMLineIndex":0}),f.now,false).unwrap();
    assert!(observe(
        &mut t,
        "ice",
        json!({"candidate":"candidate:1 1 udp 123 192.168.1.2 5000 typ host","sdpMLineIndex":0}),
        f.now
    )
    .is_err());
    t.ice(
        json!({"candidate":"candidate:1 1 udp 123 192.168.1.2 5000 typ host","sdpMLineIndex":0}),
        f.now,
        false,
    )
    .unwrap();
    assert!(!t.connected);
}
#[test]
fn ice_uses_signed_session_deadline_despite_different_delivery_delays() {
    use super::super::server_clock::ServerClock;
    let f = fixture();
    let (mut local, _) = f.identity.lock().unwrap().approved_for_runtime(f.now).unwrap();
    // Leave room for the TURN credential grace period inside the fixture key's validity.
    local.server_expires_at -= 300_000;
    local.deadline -= Duration::from_secs(300);
    let proof = signed_ice(&f, |c| {
        c["sessionExpiresAt"] = json!(local.server_expires_at);
        c["expiresAt"] = json!(local.server_expires_at + 60_000);
    });
    let later = f.now + Duration::from_secs(3);
    let clock = ServerClock::from_proof(&f.keys, &proof, later).unwrap();
    assert!(ice::verify(&f.keys, &proof, &local, clock.now(later).unwrap(), later).is_ok());
    let extended = signed_ice(&f, |c| {
        c["sessionExpiresAt"] = json!(local.server_expires_at + 1);
        c["expiresAt"] = json!(local.server_expires_at + 60_000);
    });
    assert!(ice::verify(&f.keys, &extended, &local, clock.now(later).unwrap(), later).is_err());
    assert!(ice::verify(&f.keys, &proof, &local, clock.now(later).unwrap(), local.deadline).is_err());
}
#[test]
fn ice_rejects_tampering_wrong_session_endpoint_purpose_expiry_and_unbounded_servers() {
    for edit in 0..11 {
        let f = fixture();
        let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
        let mut proof = signed_ice(&f, |c| match edit {
            0 => c["sessionId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            1 => c["host"]["generation"] = json!(99),
            2 => c["controller"]["sid"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            3 => c["purpose"] = json!("lease"),
            4 => c["issuedAt"] = json!(f.ms + 1),
            5 => c["sessionExpiresAt"] = json!(f.ms),
            6 => c["expiresAt"] = json!(f.ms + 3_900_001),
            7 => c["iceServers"][0]["urls"] = json!(["turn:password@host:3478?transport=udp"]),
            8 => c["iceServers"][0]["credential"] = json!("bad\npassword"),
            9 => c["accepted"] = json!(true),
            _ => {}
        });
        if edit == 10 {
            proof.payload.push('A');
        }
        assert!(
            t.configure_ice(&f.keys, &proof, f.ms, f.now).is_err(),
            "mutation {edit}"
        );
        assert!(t.ice_policy == CandidatePolicy::Loopback);
    }
}
#[test]
fn offer_prevents_late_network_reconfiguration() {
    let f = fixture();
    let mut t = HostTransport::reserve(f.identity.clone(), f.now).unwrap();
    t.offer(NEGOTIATION, &sdp("CD"), f.now).unwrap();
    assert!(t
        .configure_ice(&f.keys, &signed_ice(&f, |_| {}), f.ms, f.now)
        .is_err());
}
#[test]
fn network_candidates_accept_lan_ipv6_and_turn_but_not_injection_or_unresolved_names() {
    for c in [
        "candidate:1 1 udp 123 192.168.1.2 5000 typ host",
        "candidate:2 1 tcp 123 2001:db8::1 9 typ host tcptype active",
        "candidate:3 1 udp 123 203.0.113.8 45000 typ srflx raddr 192.168.1.2 rport 5000",
        "candidate:4 1 udp 123 203.0.113.9 46000 typ relay raddr 0.0.0.0 rport 0",
    ] {
        assert!(ice::candidate(c, CandidatePolicy::All).is_ok());
        assert!(ice::candidate(c, CandidatePolicy::Loopback).is_err());
    }
    for c in [
        "candidate:1 1 udp 123 224.0.0.1 5000 typ host",
        "candidate:1 1 udp 123 0.0.0.0 5000 typ host",
        "candidate:1 1 udp 123 test.local 5000 typ host",
        "candidate:1 1 udp 123 203.0.113.9 0 typ relay",
        "candidate:1 1 udp 123 203.0.113.9 5000 typ relay rport",
        "candidate:1 1 udp 123 203.0.113.9 5000 typ relay\r\n",
    ] {
        assert!(ice::candidate(c, CandidatePolicy::All).is_err());
    }
}
