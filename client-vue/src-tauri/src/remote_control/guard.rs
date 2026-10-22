//! Native session input gate. Only verified leases and trusted local consent can
//! install authority; transport readiness and each input-arm remain explicit.
#![allow(dead_code)]

use super::authorization::{LocalConsent, Scope, VerifiedLease};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: u32 = 1;
const MAX_INPUT_BYTES: usize = 4096;
const MAX_LEASE: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(3);
const INPUT_WINDOW_TTL: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    LocalStop,
    NotAuthorized,
    ConsentExpired,
    LeaseExpired,
    HeartbeatExpired,
    MediaStalled,
    SystemUnavailable,
    ProtocolMismatch,
    SessionMismatch,
    EpochMismatch,
    LayoutChanged,
    SequenceMismatch,
    InputExpired,
    OversizedInput,
    InvalidInput,
    Replay,
    InjectionFailed,
    RandomUnavailable,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReleasePlan {
    // Describes only this session's injected state, never physical local keys.
    pub keys: BTreeSet<String>,
    pub buttons: BTreeSet<u8>,
    pub stop_media: bool,
}

struct Authorization {
    session_id: String,
    consent_deadline: Instant,
    lease_deadline: Instant,
    control_epoch: u64,
    layout_version: u64,
    control_allowed: bool,
    authorization_revision: u64,
    lease_sequence: u64,
    consent: Option<LocalConsent>,
}

#[derive(Debug)]
pub struct InputEnvelope<'a> {
    pub version: u32,
    pub session_id: &'a str,
    pub control_epoch: u64,
    pub input_epoch: u64,
    pub layout_version: u64,
    pub seq: u64,
    pub input_window_id: &'a str,
    pub byte_len: usize,
}

#[derive(Default)]
pub struct SessionGuard {
    authorization: Option<Authorization>,
    armed: bool,
    native_ready: bool,
    blocked_control_epoch: Option<u64>,
    ended: bool,
    input_epoch: u64,
    next_seq: u64,
    // Filled by the native engine after cryptographically random issuance.
    input_windows: Vec<(String, Instant)>,
    last_control_heartbeat: Option<Instant>,
    last_supervisor_heartbeat: Option<Instant>,
    pressed_keys: BTreeSet<String>,
    pressed_buttons: BTreeSet<u8>,
    last_stop_reason: Option<StopReason>,
    text_commits: BTreeSet<String>,
}

pub type GuardResult<T> = Result<T, (StopReason, ReleasePlan)>;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InputContext {
    pub session_id: String,
    pub control_epoch: u64,
    pub input_epoch: u64,
    pub layout_version: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputWindow {
    #[serde(flatten)]
    pub context: InputContext,
    pub input_window_id: String,
}

impl SessionGuard {
    /// A typed VerifiedLease can only be produced by LeaseAuthority. Neither an
    /// ACK nor a webview value can install authority or implicitly arm input.
    pub fn install_verified_lease(
        &mut self,
        lease: &VerifiedLease,
        consent: &LocalConsent,
        layout_version: u64,
        now: Instant,
    ) -> GuardResult<ReleasePlan> {
        if self.ended
            || !lease.matches_consent(consent)
            || lease.session_id() != consent.session_id
            || consent.screen_id != "primary"
            || lease.deadline() <= now
            || consent.deadline <= now
            || lease.deadline() > now + MAX_LEASE
            || layout_version == 0
            || lease.authorization_revision() == 0
            || lease.lease_seq() == 0
            || lease.control_epoch() == 0
            || (lease.scope() == Scope::Control
                && (consent.scope != Scope::Control
                    || lease.authorization_revision() != consent.authorization_revision
                    || lease.control_epoch() != consent.control_epoch))
        {
            return Err((
                StopReason::NotAuthorized,
                self.stop(StopReason::NotAuthorized),
            ));
        }
        let mut release = ReleasePlan::default();
        if let Some(previous) = self.authorization.as_ref() {
            if let Some(reason) = self.expiry_reason(now, true) {
                return Err((reason, self.stop(reason)));
            }
            let same_binding = previous.consent.as_ref().is_some_and(|old| {
                old.session_id == consent.session_id
                    && old.host == consent.host
                    && old.controller == consent.controller
                    && old.screen_id == consent.screen_id
                    && consent.deadline <= old.deadline
                    && (old.consent_nonce == consent.consent_nonce
                        || (consent.authorization_revision > previous.authorization_revision
                            && consent.control_epoch > previous.control_epoch))
            });
            if !same_binding
                || layout_version != previous.layout_version
                || lease.authorization_revision() < previous.authorization_revision
                || lease.control_epoch() < previous.control_epoch
                || lease.lease_seq() <= previous.lease_sequence
            {
                return Err((
                    StopReason::EpochMismatch,
                    self.stop(StopReason::EpochMismatch),
                ));
            }
            if lease.control_epoch() != previous.control_epoch
                || lease.authorization_revision() != previous.authorization_revision
                || (lease.scope() == Scope::Control) != previous.control_allowed
            {
                release = self.pause(StopReason::NotAuthorized);
            }
        } else {
            self.last_control_heartbeat = Some(now);
            self.last_supervisor_heartbeat = Some(now);
            self.next_seq = 1;
        }
        self.authorization = Some(Authorization {
            session_id: lease.session_id().to_owned(),
            consent_deadline: consent.deadline,
            lease_deadline: lease.deadline().min(consent.deadline),
            control_epoch: lease.control_epoch(),
            layout_version,
            control_allowed: lease.scope() == Scope::Control,
            authorization_revision: lease.authorization_revision(),
            lease_sequence: lease.lease_seq(),
            consent: Some(consent.clone()),
        });
        Ok(release)
    }

    pub fn mark_native_ready(&mut self, now: Instant, system_available: bool) -> GuardResult<()> {
        self.check_live(now, system_available)?;
        self.native_ready = true;
        Ok(())
    }
    pub fn arm(
        &mut self,
        control_epoch: u64,
        layout_version: u64,
        now: Instant,
        system_available: bool,
    ) -> GuardResult<InputContext> {
        self.check_live(now, system_available)?;
        let auth = self.authorization.as_ref().expect("live authorization");
        if self.armed
            || !self.native_ready
            || !auth.control_allowed
            || control_epoch != auth.control_epoch
            || layout_version != auth.layout_version
            || self
                .blocked_control_epoch
                .is_some_and(|epoch| control_epoch <= epoch)
        {
            return Err((
                StopReason::NotAuthorized,
                self.pause(StopReason::NotAuthorized),
            ));
        }
        self.input_epoch = match self
            .input_epoch
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
        {
            Some(epoch) => epoch,
            None => {
                return Err((
                    StopReason::EpochMismatch,
                    self.stop(StopReason::EpochMismatch),
                ))
            }
        };
        self.next_seq = 1;
        self.input_windows.clear();
        self.armed = true;
        Ok(self.context().expect("armed context"))
    }
    pub fn heartbeat_controller(&mut self, now: Instant) -> GuardResult<()> {
        self.heartbeat_controller_received(now, now)
    }
    pub fn heartbeat_controller_received(
        &mut self,
        received_at: Instant,
        now: Instant,
    ) -> GuardResult<()> {
        self.check_live(now, true)?;
        if received_at > now || now.duration_since(received_at) >= HEARTBEAT_TIMEOUT {
            return Err((
                StopReason::HeartbeatExpired,
                self.stop(StopReason::HeartbeatExpired),
            ));
        }
        self.last_control_heartbeat = Some(
            self.last_control_heartbeat
                .map_or(received_at, |old| old.max(received_at)),
        );
        Ok(())
    }
    pub fn heartbeat_supervisor(&mut self, now: Instant) -> GuardResult<()> {
        self.check_live(now, true)?;
        self.last_supervisor_heartbeat = Some(now);
        Ok(())
    }
    pub fn issue_input_window(&mut self, now: Instant) -> GuardResult<InputWindow> {
        self.check_live(now, true)?;
        let Some(context) = self.context() else {
            return Err((
                StopReason::NotAuthorized,
                self.pause(StopReason::NotAuthorized),
            ));
        };
        self.input_windows.retain(|(_, issued)| {
            now.checked_duration_since(*issued)
                .is_some_and(|age| age < INPUT_WINDOW_TTL)
        });
        // Bound the native ticket set even if the caller schedules too quickly.
        if self.input_windows.len() >= 8 {
            return Err((
                StopReason::InvalidInput,
                self.pause(StopReason::InvalidInput),
            ));
        }
        let mut bytes = [0u8; 32];
        if getrandom::getrandom(&mut bytes).is_err() {
            return Err((
                StopReason::RandomUnavailable,
                self.stop(StopReason::RandomUnavailable),
            ));
        }
        let input_window_id = URL_SAFE_NO_PAD.encode(bytes);
        self.input_windows.push((input_window_id.clone(), now));
        Ok(InputWindow {
            context,
            input_window_id,
        })
    }
    pub fn context(&self) -> Option<InputContext> {
        let auth = self.authorization.as_ref()?;
        if !self.armed || self.ended {
            return None;
        }
        Some(InputContext {
            session_id: auth.session_id.clone(),
            control_epoch: auth.control_epoch,
            input_epoch: self.input_epoch,
            layout_version: auth.layout_version,
        })
    }
    pub fn expected_environment(&self) -> Option<(&str, u64)> {
        let auth = self.authorization.as_ref()?;
        Some((
            auth.consent.as_ref()?.screen_id.as_str(),
            auth.layout_version,
        ))
    }
    pub fn is_key_pressed(&self, code: &str) -> bool {
        self.pressed_keys.contains(code)
    }
    pub(super) fn execution_deadline(&self, window_id: &str) -> Option<Instant> {
        let auth = self.authorization.as_ref()?;
        let issued = self.input_windows.iter().find(|(id, _)| id == window_id)?.1;
        Some(
            auth.lease_deadline
                .min(auth.consent_deadline)
                .min(issued.checked_add(INPUT_WINDOW_TTL)?)
                .min(
                    self.last_control_heartbeat?
                        .checked_add(HEARTBEAT_TIMEOUT)?,
                )
                .min(
                    self.last_supervisor_heartbeat?
                        .checked_add(HEARTBEAT_TIMEOUT)?,
                ),
        )
    }
    pub fn is_button_pressed(&self, button: u8) -> bool {
        self.pressed_buttons.contains(&button)
    }
    pub(super) fn record_key(&mut self, code: &str, down: bool) {
        if down {
            self.pressed_keys.insert(code.to_owned());
        } else {
            self.pressed_keys.remove(code);
        }
    }
    pub(super) fn record_button(&mut self, button: u8, down: bool) {
        if down {
            self.pressed_buttons.insert(button);
        } else {
            self.pressed_buttons.remove(&button);
        }
    }
    pub(super) fn claim_text_commit(&mut self, id: &str) -> bool {
        self.text_commits.len() < 4096 && self.text_commits.insert(id.to_owned())
    }
    fn check_live(&mut self, now: Instant, system_available: bool) -> GuardResult<()> {
        if let Some(reason) = self.expiry_reason(now, system_available) {
            return Err((reason, self.stop(reason)));
        }
        Ok(())
    }

    /// Validate at the actual injection boundary, not when queued by transport.
    /// The caller must execute the returned release plan before more OS work.
    pub fn admit(
        &mut self,
        input: &InputEnvelope<'_>,
        now: Instant,
        system_available: bool,
    ) -> Result<(), (StopReason, ReleasePlan)> {
        if let Some(reason) = self.expiry_reason(now, system_available) {
            return Err((reason, self.stop(reason)));
        }
        let reason = self.input_rejection(input, now);
        if let Some(reason) = reason {
            return Err((reason, self.pause(reason)));
        }
        // Reject before exhaustion rather than wrap into an old sequence.
        match self.next_seq.checked_add(1) {
            Some(next) => self.next_seq = next,
            None => {
                return Err((
                    StopReason::SequenceMismatch,
                    self.stop(StopReason::SequenceMismatch),
                ))
            }
        }
        Ok(())
    }

    fn input_rejection(&self, input: &InputEnvelope<'_>, now: Instant) -> Option<StopReason> {
        let auth = match self.authorization.as_ref() {
            Some(auth) if !self.ended && self.armed && auth.control_allowed => auth,
            _ => return Some(StopReason::NotAuthorized),
        };
        if input.version != PROTOCOL_VERSION {
            return Some(StopReason::ProtocolMismatch);
        }
        if input.byte_len == 0 || input.byte_len > MAX_INPUT_BYTES {
            return Some(StopReason::OversizedInput);
        }
        if input.session_id != auth.session_id {
            return Some(StopReason::SessionMismatch);
        }
        if input.control_epoch != auth.control_epoch || input.input_epoch != self.input_epoch {
            return Some(StopReason::EpochMismatch);
        }
        if input.layout_version != auth.layout_version {
            return Some(StopReason::LayoutChanged);
        }
        if input.seq != self.next_seq {
            return Some(StopReason::SequenceMismatch);
        }
        let valid_window = self.input_windows.iter().any(|(id, issued)| {
            id == input.input_window_id
                && now
                    .checked_duration_since(*issued)
                    .is_some_and(|age| age < INPUT_WINDOW_TTL)
        });
        if !valid_window {
            return Some(StopReason::InputExpired);
        }
        None
    }

    fn expiry_reason(&self, now: Instant, system_available: bool) -> Option<StopReason> {
        let auth = match self.authorization.as_ref() {
            Some(auth) if !self.ended => auth,
            _ => return Some(StopReason::NotAuthorized),
        };
        if !system_available {
            return Some(StopReason::SystemUnavailable);
        }
        if now >= auth.consent_deadline {
            return Some(StopReason::ConsentExpired);
        }
        if now >= auth.lease_deadline {
            return Some(StopReason::LeaseExpired);
        }
        for heartbeat in [self.last_control_heartbeat, self.last_supervisor_heartbeat] {
            if !heartbeat.is_some_and(|last| {
                now.checked_duration_since(last)
                    .is_some_and(|age| age < HEARTBEAT_TIMEOUT)
            }) {
                return Some(StopReason::HeartbeatExpired);
            }
        }
        None
    }

    /// Called by an independent native watchdog, even when no input arrives.
    pub fn tick(&mut self, now: Instant, system_available: bool) -> Option<ReleasePlan> {
        if self.authorization.is_none() || self.ended {
            return None;
        }
        self.expiry_reason(now, system_available)
            .map(|reason| self.stop(reason))
    }

    /// Host pause/protocol rejection requires a newly approved control epoch.
    pub fn pause(&mut self, reason: StopReason) -> ReleasePlan {
        if let Some(auth) = &self.authorization {
            self.blocked_control_epoch = Some(auth.control_epoch);
        }
        self.release_input(reason)
    }

    /// Controller blur/focus cleanup permits a fresh explicit arm in the same
    /// control epoch, but never accepts any old ticket or sequence.
    pub fn release_input(&mut self, reason: StopReason) -> ReleasePlan {
        self.armed = false;
        self.input_windows.clear();
        self.next_seq = 1;
        self.last_stop_reason = Some(reason);
        // Exhaustion is terminal; an old input epoch can never become current.
        if let Some(epoch) = self.input_epoch.checked_add(1) {
            self.input_epoch = epoch;
        } else {
            self.ended = true;
            self.authorization = None;
        }
        ReleasePlan {
            keys: std::mem::take(&mut self.pressed_keys),
            buttons: std::mem::take(&mut self.pressed_buttons),
            stop_media: self.ended,
        }
    }

    /// Independent of network availability, input tickets and sequence numbers.
    pub fn stop(&mut self, reason: StopReason) -> ReleasePlan {
        let mut release = self.pause(reason);
        self.ended = true;
        self.native_ready = false;
        self.authorization = None;
        self.last_control_heartbeat = None;
        self.last_supervisor_heartbeat = None;
        release.stop_media = true;
        release
    }
}

/// A verified response cannot extend its deadline by arriving late. Challenge
/// consumption/signature/sequence verification are future engine prerequisites.
fn lease_deadline(challenge_sent: Instant, received: Instant, ttl: Duration) -> Option<Instant> {
    if ttl.is_zero() || ttl > MAX_LEASE || received < challenge_sent {
        return None;
    }
    let deadline = challenge_sent.checked_add(ttl)?;
    (received < deadline).then_some(deadline)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(now: Instant) -> SessionGuard {
        SessionGuard {
            authorization: Some(Authorization {
                session_id: "session-1".into(),
                consent_deadline: now + Duration::from_secs(60),
                lease_deadline: now + MAX_LEASE,
                control_epoch: 3,
                layout_version: 2,
                control_allowed: true,
                authorization_revision: 1,
                lease_sequence: 1,
                consent: None,
            }),
            armed: true,
            input_epoch: 4,
            next_seq: 1,
            input_windows: vec![("native-ticket".into(), now)],
            last_control_heartbeat: Some(now),
            last_supervisor_heartbeat: Some(now),
            ..SessionGuard::default()
        }
    }

    fn input() -> InputEnvelope<'static> {
        InputEnvelope {
            version: 1,
            session_id: "session-1",
            control_epoch: 3,
            input_epoch: 4,
            layout_version: 2,
            seq: 1,
            input_window_id: "native-ticket",
            byte_len: 200,
        }
    }

    #[test]
    fn default_and_stopped_sessions_cannot_accept_input() {
        let now = Instant::now();
        assert!(SessionGuard::default().admit(&input(), now, true).is_err());
        let mut guard = fixture(now);
        guard.stop(StopReason::LocalStop);
        assert!(guard.admit(&input(), now, true).is_err());
    }

    #[test]
    fn current_authorization_and_contiguous_input_are_required() {
        let now = Instant::now();
        let mut guard = fixture(now);
        assert!(guard.admit(&input(), now, true).is_ok());
        let mut next = input();
        next.seq = 2;
        assert!(guard.admit(&next, now, true).is_ok());
        assert_eq!(
            guard.admit(&next, now, true).unwrap_err().0,
            StopReason::SequenceMismatch
        );
        assert!(!guard.armed);
    }

    #[test]
    fn tampered_envelopes_pause_and_release() {
        let now = Instant::now();
        for kind in 0..8 {
            let mut envelope = input();
            let expected = match kind {
                0 => {
                    envelope.version = 2;
                    StopReason::ProtocolMismatch
                }
                1 => {
                    envelope.session_id = "other";
                    StopReason::SessionMismatch
                }
                2 => {
                    envelope.control_epoch = 1;
                    StopReason::EpochMismatch
                }
                3 => {
                    envelope.input_epoch = 1;
                    StopReason::EpochMismatch
                }
                4 => {
                    envelope.layout_version = 1;
                    StopReason::LayoutChanged
                }
                5 => {
                    envelope.seq = 3;
                    StopReason::SequenceMismatch
                }
                6 => {
                    envelope.input_window_id = "forged";
                    StopReason::InputExpired
                }
                _ => {
                    envelope.byte_len = 4097;
                    StopReason::OversizedInput
                }
            };
            let mut guard = fixture(now);
            guard.pressed_keys.insert("ControlLeft".into());
            let (reason, release) = guard.admit(&envelope, now, true).unwrap_err();
            assert_eq!(reason, expected);
            assert_eq!(release.keys.len(), 1);
            assert!(!release.stop_media);
            assert!(!guard.armed);
            assert_eq!(guard.input_epoch, 5);
        }
    }

    #[test]
    fn input_window_expires_at_500ms_and_cannot_be_replayed() {
        let now = Instant::now();
        let mut guard = fixture(now);
        assert_eq!(
            guard
                .admit(&input(), now + INPUT_WINDOW_TTL, true)
                .unwrap_err()
                .0,
            StopReason::InputExpired
        );
        assert!(guard.admit(&input(), now, true).is_err());
    }

    #[test]
    fn watchdog_stops_on_either_missing_heartbeat() {
        let now = Instant::now();
        for stale_controller in [false, true] {
            let mut guard = fixture(now);
            let tick = now + HEARTBEAT_TIMEOUT;
            if stale_controller {
                guard.last_supervisor_heartbeat = Some(tick);
            } else {
                guard.last_control_heartbeat = Some(tick);
            }
            assert!(guard.tick(tick, true).unwrap().stop_media);
            assert_eq!(guard.last_stop_reason, Some(StopReason::HeartbeatExpired));
            assert!(guard.tick(tick, true).is_none());
        }
    }

    #[test]
    fn lease_expiry_stops_even_with_live_peer_and_supervisor() {
        let now = Instant::now();
        let mut guard = fixture(now);
        let tick = now + MAX_LEASE;
        guard.last_control_heartbeat = Some(tick);
        guard.last_supervisor_heartbeat = Some(tick);
        assert!(guard.tick(tick, true).unwrap().stop_media);
        assert_eq!(guard.last_stop_reason, Some(StopReason::LeaseExpired));
    }

    #[test]
    fn permission_loss_stops_media_and_releases_only_session_ledger() {
        let now = Instant::now();
        let mut guard = fixture(now);
        guard.pressed_keys.insert("KeyA".into());
        guard.pressed_buttons.insert(0);
        let release = guard.tick(now, false).unwrap();
        assert!(release.stop_media);
        assert_eq!(release.keys, BTreeSet::from(["KeyA".to_owned()]));
        assert_eq!(release.buttons, BTreeSet::from([0]));
        let second = guard.stop(StopReason::LocalStop);
        assert!(second.keys.is_empty() && second.buttons.is_empty());
    }

    #[test]
    fn view_consent_does_not_authorize_input() {
        let now = Instant::now();
        let mut guard = fixture(now);
        guard.authorization.as_mut().unwrap().control_allowed = false;
        assert_eq!(
            guard.admit(&input(), now, true).unwrap_err().0,
            StopReason::NotAuthorized
        );
    }

    #[test]
    fn delayed_lease_uses_challenge_send_time() {
        let now = Instant::now();
        assert_eq!(
            lease_deadline(now, now + Duration::from_secs(14), MAX_LEASE),
            Some(now + MAX_LEASE)
        );
        assert!(lease_deadline(now, now + MAX_LEASE, MAX_LEASE).is_none());
        assert!(lease_deadline(now, now, Duration::from_secs(16)).is_none());
        assert!(lease_deadline(now, now, Duration::ZERO).is_none());
    }

    #[test]
    fn exhausted_input_epoch_stops_instead_of_wrapping() {
        let now = Instant::now();
        let mut guard = fixture(now);
        guard.input_epoch = u64::MAX;
        assert!(guard.pause(StopReason::LocalStop).stop_media);
        assert!(guard.ended);
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use super::*;
    use crate::remote_control::authorization::{
        LeaseAuthority, ObservedTransport, PinnedKeys, SignedEnvelope,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{json, Value};
    pub fn verified(now: Instant, scope: Scope, epoch: u64) -> (VerifiedLease, LocalConsent) {
        verified_sequence(now, scope, epoch, 1)
    }
    pub fn verified_sequence(
        now: Instant,
        scope: Scope,
        epoch: u64,
        sequence: u64,
    ) -> (VerifiedLease, LocalConsent) {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/remote-control-credentials-v1.json"
        ))
        .unwrap();
        let keys =
            PinnedKeys::new(vec![serde_json::from_value(fixture["key"].clone()).unwrap()]).unwrap();
        let ms = fixture["now"].as_u64().unwrap();
        let mut claims = fixture["claims"].clone();
        claims["screenId"] = "primary".into();
        claims["scope"] = json!(scope);
        claims["authorizationRevision"] = epoch.into();
        claims["controlEpoch"] = epoch.into();
        let consent = LocalConsent {
            session_id: claims["sessionId"].as_str().unwrap().into(),
            host: serde_json::from_value(claims["host"].clone()).unwrap(),
            controller: serde_json::from_value(claims["controller"].clone()).unwrap(),
            consent_nonce: claims["consentNonce"].as_str().unwrap().into(),
            screen_id: "primary".into(),
            scope,
            authorization_revision: epoch,
            control_epoch: epoch,
            deadline: now + Duration::from_secs(60),
            server_expires_at: ms + 60_000,
        };
        let transport = ObservedTransport {
            negotiation_id: claims["negotiationId"].as_str().unwrap().into(),
            host_fingerprint: claims["hostFingerprint"].as_str().unwrap().into(),
            controller_fingerprint: claims["controllerFingerprint"].as_str().unwrap().into(),
        };
        // RFC 8032 public test vector seed, never a deployment credential.
        let key = SigningKey::from_bytes(&[
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ]);
        let sign = |claims: &Value| {
            let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
            let signature = URL_SAFE_NO_PAD.encode(
                key.sign(format!("todesk-remote-control/v1\nfixture-only\n{payload}").as_bytes())
                    .to_bytes(),
            );
            serde_json::from_value::<SignedEnvelope>(json!({"format":"rc-signed-v1","keyId":"fixture-only","payload":payload,"signature":signature})).unwrap()
        };
        let mut authority = LeaseAuthority::verify_connection(
            keys,
            &sign(&claims),
            consent.clone(),
            transport,
            ms,
            now,
        )
        .unwrap();
        for _ in 1..sequence {
            authority.challenge(now).unwrap();
        }
        let challenge = authority.challenge(now).unwrap();
        claims["purpose"] = "lease".into();
        claims["expiresAt"] = (ms + 15000).into();
        claims["challenge"] = challenge.challenge.into();
        claims["leaseSeq"] = challenge.lease_seq.into();
        (
            authority.accept_lease(&sign(&claims), ms, now).unwrap(),
            consent,
        )
    }
    pub fn live_guard(now: Instant) -> (SessionGuard, InputWindow) {
        let (lease, consent) = verified(now, Scope::Control, 1);
        let mut guard = SessionGuard::default();
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        guard.mark_native_ready(now, true).unwrap();
        guard.arm(1, 1, now, true).unwrap();
        let window = guard.issue_input_window(now).unwrap();
        (guard, window)
    }
}

#[cfg(test)]
mod verified_tests {
    use super::*;
    #[test]
    fn verified_install_and_transport_ready_do_not_implicitly_arm() {
        let now = Instant::now();
        let (lease, consent) = test_support::verified(now, Scope::Control, 1);
        let mut guard = SessionGuard::default();
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        assert!(guard.context().is_none());
        guard.mark_native_ready(now, true).unwrap();
        assert!(guard.context().is_none());
        assert_eq!(guard.arm(1, 1, now, true).unwrap().input_epoch, 1);
    }
    #[test]
    fn view_install_and_mismatched_local_consent_never_arm() {
        let now = Instant::now();
        let (lease, consent) = test_support::verified(now, Scope::View, 1);
        let mut guard = SessionGuard::default();
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        guard.mark_native_ready(now, true).unwrap();
        assert!(guard.arm(1, 1, now, true).is_err());
        let (lease, mut consent) = test_support::verified(now, Scope::Control, 1);
        consent.scope = Scope::View;
        assert!(SessionGuard::default()
            .install_verified_lease(&lease, &consent, 1, now)
            .is_err());
    }
    #[test]
    fn blur_rotates_input_epoch_but_host_pause_needs_new_control_epoch() {
        let now = Instant::now();
        let (mut guard, first) = test_support::live_guard(now);
        guard.release_input(StopReason::LocalStop);
        let next = guard.arm(1, 1, now, true).unwrap();
        assert!(next.input_epoch > first.context.input_epoch);
        guard.pause(StopReason::LocalStop);
        assert!(guard.arm(1, 1, now, true).is_err());
        let (lease, consent) = test_support::verified_sequence(now, Scope::Control, 2, 2);
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        assert!(guard.context().is_none());
        assert!(guard.arm(2, 1, now, true).is_ok());
    }
    #[test]
    fn live_renewal_does_not_arm_and_expired_guard_cannot_resurrect() {
        let now = Instant::now();
        let (lease, consent) = test_support::verified(now, Scope::Control, 1);
        let mut guard = SessionGuard::default();
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        let (lease, consent) = test_support::verified_sequence(now, Scope::Control, 1, 2);
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        assert!(guard.context().is_none());
        assert!(guard
            .install_verified_lease(&lease, &consent, 1, now + MAX_LEASE)
            .is_err());
        assert!(guard
            .install_verified_lease(&lease, &consent, 1, now)
            .is_err());
    }
    #[test]
    fn fresh_lease_in_paused_control_epoch_cannot_rearm() {
        let now = Instant::now();
        let (mut guard, _) = test_support::live_guard(now);
        guard.pause(StopReason::LocalStop);
        let (lease, consent) = test_support::verified_sequence(now, Scope::Control, 1, 2);
        guard
            .install_verified_lease(&lease, &consent, 1, now)
            .unwrap();
        assert!(guard.context().is_none());
        assert!(guard.arm(1, 1, now, true).is_err());
    }
    #[test]
    fn native_random_windows_are_bounded_and_not_renewed_by_input() {
        let now = Instant::now();
        let (mut guard, first) = test_support::live_guard(now);
        let second = guard.issue_input_window(now).unwrap();
        assert_ne!(first.input_window_id, second.input_window_id);
        assert_eq!(
            super::super::authorization::decode(&first.input_window_id, Some(32))
                .unwrap()
                .len(),
            32
        );
        for _ in 0..6 {
            guard.issue_input_window(now).unwrap();
        }
        assert!(guard.issue_input_window(now).is_err());
        assert!(guard.context().is_none());
    }
    #[test]
    fn same_session_lease_cannot_replace_endpoint_or_extend_local_consent() {
        let now = Instant::now();
        let (lease, consent) = test_support::verified(now, Scope::Control, 1);
        for change_endpoint in [false, true] {
            let mut guard = SessionGuard::default();
            guard
                .install_verified_lease(&lease, &consent, 1, now)
                .unwrap();
            let mut altered = consent.clone();
            if change_endpoint {
                altered.controller.connection_id = "another".into();
            } else {
                altered.deadline += Duration::from_secs(1);
            }
            assert!(SessionGuard::default()
                .install_verified_lease(&lease, &altered, 1, now)
                .is_err());
            assert!(guard
                .install_verified_lease(&lease, &altered, 1, now)
                .is_err());
        }
    }
}
