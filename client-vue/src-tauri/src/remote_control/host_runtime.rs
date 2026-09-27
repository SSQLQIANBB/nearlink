//! Native host session owner. No methods here are Tauri invoke commands. Network
//! adapters must first authenticate their IPC/DTLS peer; Vue cannot install a
//! lease, claim local consent, announce readiness or execute system input.
#![allow(dead_code)]
use super::{
    authorization::{
        LeaseAuthority, LeaseChallenge, LocalConsent, ObservedTransport, PinnedKeys, Scope,
        SignedEnvelope, VerifiedLease,
    },
    guard::{InputContext, InputWindow, ReleasePlan, SessionGuard, StopReason},
    identity::{IdentityState, RuntimeClaim},
    input::{self, InputAck, InputExecutor},
    media_layout::{DisplaySnapshot, MediaLayout},
    media_liveness::{MediaHealth, MediaLiveness, MediaStatus, NativeMediaProgress},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(super) type HostResult<T> = Result<T, &'static str>;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(3);
const WATCHDOG_INTERVAL: Duration = Duration::from_millis(100);

/// Methods must have bounded execution; a process implementation must kill and
/// reap its child on terminate even if stop-media acknowledgement never arrives.
pub(super) trait MediaDriver: Send {
    fn start_media(&mut self, lease: &VerifiedLease, now: Instant) -> HostResult<()>;
    fn renew_media(&mut self, lease: &VerifiedLease, now: Instant) -> HostResult<()>;
    fn stop_media(&mut self) -> HostResult<()>;
    fn terminate(&mut self) -> HostResult<()>;
    fn send_channel(&mut self, label: &str, data: &[u8]) -> HostResult<()>;
    fn healthy(&self) -> bool;
    fn media_progress(&self) -> HostResult<NativeMediaProgress>;
    fn media_layout(&self) -> HostResult<Option<MediaLayout>>;
}

/// The existing executor checks this minimum before each actual OS post, even
/// when decoding/preflight/Unicode preparation takes us across a freeze limit.
struct LiveInput<'a> {
    inner: &'a mut dyn InputExecutor,
    media: &'a mut dyn MediaDriver,
    expected_layout: &'a MediaLayout,
    deadline: Instant,
    expired: bool,
}
impl LiveInput<'_> {
    fn check_layout(&mut self) -> Result<(), input::InputError> {
        if self
            .media
            .media_layout()
            .map_err(|_| input::InputError::LayoutChanged)?
            .as_ref()
            != Some(self.expected_layout)
            || self.inner.display_snapshot()? != self.expected_layout.geometry.display_snapshot()
        {
            return Err(input::InputError::LayoutChanged);
        }
        Ok(())
    }
}
impl InputExecutor for LiveInput<'_> {
    fn display_snapshot(&mut self) -> Result<DisplaySnapshot, input::InputError> {
        self.inner.display_snapshot()
    }
    fn preflight(&mut self) -> Result<input::InputEnvironment, input::InputError> {
        let environment = self.inner.preflight()?;
        self.check_layout()?;
        Ok(environment)
    }
    fn execute(
        &mut self,
        action: &input::InputAction,
        deadline: Instant,
    ) -> Result<(), input::InputError> {
        self.check_layout()?;
        if Instant::now() >= self.deadline {
            self.expired = true;
            return Err(input::InputError::Expired);
        }
        let result = self.inner.execute(action, deadline.min(self.deadline));
        self.expired |=
            result == Err(input::InputError::Expired) && Instant::now() >= self.deadline;
        result
    }
    fn release(&mut self, plan: &ReleasePlan) -> Result<(), input::InputError> {
        self.inner.release(plan)
    }
}
#[derive(Clone, Copy)]
pub(super) struct Availability {
    pub capture: bool,
    pub input: bool,
}
pub(super) type AvailabilityProbe = Box<dyn Fn() -> Availability + Send + Sync>;

pub(super) struct HostRuntime {
    identity: Arc<Mutex<IdentityState>>,
    generation: u64,
    local: LocalConsent,
    connection: SignedEnvelope,
    negotiation_id: String,
    last_state_sent: Option<Instant>,
    last_window_sent: Option<Instant>,
    highest_issued_input_epoch: u64,
    authority: LeaseAuthority,
    guard: SessionGuard,
    input: Box<dyn InputExecutor>,
    media: Box<dyn MediaDriver>,
    probe: AvailabilityProbe,
    layout_version: u64,
    bound_layout: Option<MediaLayout>,
    layout_sent: bool,
    latest_lease: Option<VerifiedLease>,
    ready: bool,
    paused: bool,
    ended: bool,
    media_started: bool,
    process_terminated: bool,
    liveness: MediaLiveness,
    media_health: MediaHealth,
    last_controller: Instant,
    last_supervisor: Instant,
    pending_release: ReleasePlan,
    stop_reason: Option<StopReason>,
}
impl HostRuntime {
    /// Evidence originates after verified DTLS + controller proof/hello, never from invoke arguments.
    pub fn native_fact(
        &mut self,
        transport: &ObservedTransport,
        challenge: Option<LeaseChallenge>,
        now_ms: u64,
        now: Instant,
    ) -> HostResult<SignedEnvelope> {
        self.ensure_live(now)?;
        if !self.ready || transport.negotiation_id != self.negotiation_id {
            return Err("REMOTE_NATIVE_READY_REQUIRED");
        }
        let mut body = json!({ "protocolVersion":1, "purpose":if challenge.is_some() { "native-lease-challenge" } else { "native-ready" },
            "sessionId":self.local.session_id, "host":self.local.host, "negotiationId":transport.negotiation_id,
            "hostFingerprint":transport.host_fingerprint, "controllerFingerprint":transport.controller_fingerprint,
            "consentNonce":self.local.consent_nonce, "screenId":self.local.screen_id,
            "authorizationRevision":self.local.authorization_revision, "controlEpoch":self.local.control_epoch,
            "issuedAt":now_ms, "expiresAt":now_ms.checked_add(10_000).ok_or("REMOTE_CLOCK_INVALID")? });
        if let Some(challenge) = challenge {
            body["challenge"] = json!(challenge.challenge);
            body["leaseSeq"] = json!(challenge.lease_seq);
        }
        let state = self
            .identity
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        let (current, _) = state.approved_for_runtime(now)?;
        body["authorizationRevision"] = json!(current.authorization_revision);
        body["controlEpoch"] = json!(current.control_epoch);
        super::identity::sign_runtime_fact(
            &state,
            self.generation,
            &self.local.session_id,
            body,
            now,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn connect(
        identity: Arc<Mutex<IdentityState>>,
        keys: PinnedKeys,
        connection: &SignedEnvelope,
        transport: ObservedTransport,
        mut media: Box<dyn MediaDriver>,
        input: Box<dyn InputExecutor>,
        probe: AvailabilityProbe,
        layout_version: u64,
        now_ms: u64,
        now: Instant,
    ) -> HostResult<Self> {
        let claim = match RuntimeClaim::reserve(identity, now) {
            Ok(value) => value,
            Err(error) => {
                let _ = media.terminate();
                return Err(error);
            }
        };
        Self::connect_claimed(
            claim,
            keys,
            connection,
            transport,
            media,
            input,
            probe,
            layout_version,
            now_ms,
            now,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn connect_claimed(
        claim: RuntimeClaim,
        keys: PinnedKeys,
        connection: &SignedEnvelope,
        transport: ObservedTransport,
        mut media: Box<dyn MediaDriver>,
        input: Box<dyn InputExecutor>,
        probe: AvailabilityProbe,
        layout_version: u64,
        now_ms: u64,
        now: Instant,
    ) -> HostResult<Self> {
        let (identity, local, generation) = match claim.transfer(now) {
            Ok(value) => value,
            Err(error) => {
                let _ = media.terminate();
                return Err(error);
            }
        };
        let negotiation_id = transport.negotiation_id.clone();
        let authority = match LeaseAuthority::verify_connection(
            keys,
            connection,
            local.clone(),
            transport,
            now_ms,
            now,
        ) {
            Ok(value) => value,
            Err(_) => {
                if let Ok(mut state) = identity.lock() {
                    state.end_runtime(generation, &local.session_id);
                }
                let _ = media.terminate();
                return Err("INVALID_REMOTE_CONNECTION");
            }
        };
        Ok(Self {
            identity,
            generation,
            local,
            connection: connection.clone(),
            negotiation_id,
            last_state_sent: None,
            last_window_sent: None,
            highest_issued_input_epoch: 0,
            authority,
            guard: SessionGuard::default(),
            input,
            media,
            probe,
            layout_version,
            bound_layout: None,
            layout_sent: false,
            latest_lease: None,
            ready: false,
            paused: false,
            ended: false,
            media_started: false,
            process_terminated: false,
            liveness: MediaLiveness::default(),
            media_health: MediaHealth::default(),
            last_controller: now,
            last_supervisor: now,
            pending_release: ReleasePlan::default(),
            stop_reason: None,
        })
    }
    fn ensure_live(&mut self, now: Instant) -> HostResult<()> {
        if self.ended {
            return Err("REMOTE_SESSION_ENDED");
        }
        self.check_media_layout()?;
        // Classify a known freeze before a simultaneous sidecar fallback exit.
        self.check_media_liveness(now)?;
        let current = self
            .identity
            .lock()
            .map(|s| s.runtime_is_current(self.generation, &self.local.session_id, now))
            .unwrap_or(false);
        let available = (self.probe)();
        let reason = if !current {
            Some(StopReason::NotAuthorized)
        } else if now >= self.local.deadline {
            Some(StopReason::ConsentExpired)
        } else if now >= self.authority.deadline() {
            Some(StopReason::LeaseExpired)
        } else if !self.media.healthy() {
            Some(StopReason::SystemUnavailable)
        } else if !available.capture
            || (self.authority.current_scope() == Scope::Control && !available.input)
        {
            Some(StopReason::SystemUnavailable)
        } else if [self.last_controller, self.last_supervisor]
            .iter()
            .any(|last| {
                !now.checked_duration_since(*last)
                    .is_some_and(|age| age < HEARTBEAT_TIMEOUT)
            })
        {
            Some(StopReason::HeartbeatExpired)
        } else {
            None
        };
        let reason = reason.or_else(|| {
            if self.authority.current_scope() != Scope::Control {
                return None;
            }
            match self.input.preflight() {
                Ok(environment)
                    if environment.screen_id == self.local.screen_id
                        && environment.layout_version == self.layout_version =>
                {
                    None
                }
                _ => Some(StopReason::SystemUnavailable),
            }
        });
        if let Some(reason) = reason {
            let _ = self.stop(reason);
            return Err("REMOTE_AUTHORITY_EXPIRED");
        }
        if !self.pending_release.keys.is_empty() || !self.pending_release.buttons.is_empty() {
            if self.retry_release().is_err() {
                let _ = self.stop(StopReason::SystemUnavailable);
                return Err("REMOTE_INPUT_RELEASE_FAILED");
            }
        }
        self.check_media_liveness(now)?;
        Ok(())
    }
    fn check_media_liveness(&mut self, now: Instant) -> HostResult<()> {
        if !self.media_started {
            return Ok(());
        }
        let progress = match self.media.media_progress() {
            Ok(progress) => progress,
            Err(error) => {
                let _ = self.stop(StopReason::SystemUnavailable);
                return Err(error);
            }
        };
        self.media_health = self.liveness.health(progress, now.max(Instant::now()));
        match self.media_health.status {
            MediaStatus::Frozen => {
                let _ = self.stop(StopReason::MediaStalled);
                Err("REMOTE_MEDIA_FROZEN")
            }
            MediaStatus::Stalled if !self.paused => self.pause(StopReason::MediaStalled),
            _ => Ok(()),
        }
    }
    fn check_media_layout(&mut self) -> HostResult<()> {
        let result = (|| {
            let layout = self.media.media_layout()?;
            let Some(layout) = layout else {
                return if self.bound_layout.is_some() {
                    Err("REMOTE_MEDIA_LAYOUT_CHANGED")
                } else {
                    Ok(())
                };
            };
            layout.validate()?;
            if layout.screen_id != self.local.screen_id
                || layout.layout_version != self.layout_version
                || self
                    .bound_layout
                    .as_ref()
                    .is_some_and(|bound| *bound != layout)
                || self
                    .input
                    .display_snapshot()
                    .map_err(|_| "REMOTE_MEDIA_LAYOUT_CHANGED")?
                    != layout.geometry.display_snapshot()
            {
                return Err("REMOTE_MEDIA_LAYOUT_CHANGED");
            }
            if self.bound_layout.is_none() {
                self.bound_layout = Some(layout);
            }
            if self.ready && self.latest_lease.is_some() && !self.layout_sent {
                self.send_state(
                    "layout",
                    serde_json::to_value(self.bound_layout.as_ref().unwrap())
                        .map_err(|_| "REMOTE_MEDIA_LAYOUT_INVALID")?,
                )?;
                self.layout_sent = true;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = self.stop(StopReason::LayoutChanged);
        }
        result
    }
    fn live_input_deadline(&self, now: Instant) -> HostResult<Instant> {
        let progress = self.media.media_progress()?;
        self.liveness
            .input_deadline(progress, now.max(Instant::now()))
            .ok_or("REMOTE_MEDIA_NOT_LIVE")
    }
    fn ready(&mut self, now: Instant) -> HostResult<()> {
        self.ensure_live(now)?;
        self.ready = true;
        if self.latest_lease.is_some() {
            self.guard_ready(now)?;
        }
        self.start_if_authorized(now)
    }
    fn guard_ready(&mut self, now: Instant) -> HostResult<()> {
        match self.guard.mark_native_ready(now, true) {
            Ok(()) => Ok(()),
            Err((reason, release)) => {
                self.consume_release(release);
                let _ = self.stop(reason);
                Err("REMOTE_GUARD_REJECTED")
            }
        }
    }
    pub fn challenge(&mut self, now: Instant) -> HostResult<LeaseChallenge> {
        self.ensure_live(now)?;
        if !self.ready {
            return Err("REMOTE_TRANSPORT_NOT_READY");
        }
        match self.authority.challenge(now) {
            Ok(value) => Ok(value),
            Err(_) => {
                let _ = self.stop(StopReason::NotAuthorized);
                Err("REMOTE_CHALLENGE_REJECTED")
            }
        }
    }
    pub fn accept_lease(
        &mut self,
        envelope: &SignedEnvelope,
        now_ms: u64,
        now: Instant,
    ) -> HostResult<()> {
        self.ensure_live(now)?;
        let lease = match self.authority.accept_lease(envelope, now_ms, now) {
            Ok(value) => value,
            Err(_) => {
                let _ = self.stop(StopReason::NotAuthorized);
                return Err("INVALID_REMOTE_LEASE");
            }
        };
        match self
            .guard
            .install_verified_lease(&lease, &self.local, self.layout_version, now)
        {
            Ok(release) => self.consume_release(release),
            Err((reason, release)) => {
                self.consume_release(release);
                let _ = self.stop(reason);
                return Err("REMOTE_GUARD_REJECTED");
            }
        }
        if self.retry_release().is_err() {
            let _ = self.stop(StopReason::SystemUnavailable);
            return Err("REMOTE_INPUT_RELEASE_FAILED");
        }
        let synchronized = self
            .identity
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .observe_view_lease(self.generation, &lease, now);
        if synchronized.is_err() {
            let _ = self.stop(StopReason::NotAuthorized);
            return Err("REMOTE_OPERATION_CANCELLED");
        }
        if self.media_started {
            if let Err(error) = self.media.renew_media(&lease, now) {
                let _ = self.stop(StopReason::SystemUnavailable);
                return Err(error);
            }
        }
        let changed = self
            .latest_lease
            .as_ref()
            .is_some_and(|old| lease.control_epoch() > old.control_epoch());
        if changed && lease.scope() == Scope::Control {
            self.paused = false;
        }
        self.latest_lease = Some(lease);
        if self.ready {
            self.guard_ready(now)?;
        }
        self.start_if_authorized(now)?;
        Ok(())
    }
    fn start_if_authorized(&mut self, now: Instant) -> HostResult<()> {
        self.ensure_live(now)?;
        if !self.ready || self.latest_lease.is_none() || self.media_started {
            return Ok(());
        }
        let baseline = self.media.media_progress()?;
        if let Err(error) = self
            .media
            .start_media(self.latest_lease.as_ref().unwrap(), now)
        {
            let _ = self.stop(StopReason::SystemUnavailable);
            return Err(error);
        }
        self.media_started = true;
        self.liveness.start(now, baseline)?;
        self.check_media_liveness(now)?;
        Ok(())
    }
    /// A new OS confirmation remains unarmed; another challenge and signed
    /// control lease are required. This reads native state, never a Vue record.
    pub fn refresh_local_consent(&mut self, now: Instant) -> HostResult<()> {
        self.ensure_live(now)?;
        let (next, generation) = self
            .identity
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .approved_for_runtime(now)?;
        if generation != self.generation {
            let _ = self.stop(StopReason::NotAuthorized);
            return Err("REMOTE_OPERATION_CANCELLED");
        }
        self.authority
            .replace_local_consent(next.clone(), now)
            .map_err(|_| "REMOTE_LOCAL_CONSENT_REQUIRED")?;
        self.local = next;
        Ok(())
    }
    pub fn controller_heartbeat(&mut self, now: Instant) -> HostResult<()> {
        self.controller_heartbeat_received(now, now)
    }
    fn controller_heartbeat_received(
        &mut self,
        received_at: Instant,
        now: Instant,
    ) -> HostResult<()> {
        self.ensure_live(now)?;
        self.last_controller = self.last_controller.max(received_at);
        if self.latest_lease.is_some() {
            if let Err((reason, release)) = self
                .guard
                .heartbeat_controller_received(self.last_controller, now)
            {
                self.consume_release(release);
                let _ = self.stop(reason);
                return Err("REMOTE_HEARTBEAT_EXPIRED");
            }
        }
        Ok(())
    }
    pub fn supervisor_heartbeat(&mut self, now: Instant) -> HostResult<()> {
        self.ensure_live(now)?;
        self.last_supervisor = now;
        if self.latest_lease.is_some() {
            if let Err((reason, release)) = self.guard.heartbeat_supervisor(now) {
                self.consume_release(release);
                let _ = self.stop(reason);
                return Err("REMOTE_HEARTBEAT_EXPIRED");
            }
        }
        Ok(())
    }
    pub fn arm_input(&mut self, now: Instant) -> HostResult<InputContext> {
        self.ensure_live(now)?;
        if self.bound_layout.is_none() {
            return Err("REMOTE_MEDIA_LAYOUT_REQUIRED");
        }
        self.live_input_deadline(now)?;
        let lease = self.latest_lease.as_ref().ok_or("REMOTE_LEASE_REQUIRED")?;
        if !self.ready || self.paused || !self.media_started || lease.scope() != Scope::Control {
            return Err("REMOTE_CONTROL_NOT_ALLOWED");
        }
        match self
            .guard
            .arm(lease.control_epoch(), self.layout_version, now, true)
        {
            Ok(context) => {
                self.highest_issued_input_epoch = context.input_epoch;
                Ok(context)
            }
            Err((reason, release)) => {
                self.consume_release(release);
                if self.retry_release().is_err() {
                    let _ = self.stop(reason);
                }
                Err("REMOTE_INPUT_NOT_ARMED")
            }
        }
    }
    pub fn input_window(&mut self, now: Instant) -> HostResult<InputWindow> {
        self.ensure_live(now)?;
        self.live_input_deadline(now)?;
        match self.guard.issue_input_window(now) {
            Ok(window) => Ok(window),
            Err((reason, release)) => {
                self.consume_release(release);
                if self.retry_release().is_err() {
                    let _ = self.stop(reason);
                }
                Err("REMOTE_INPUT_NOT_ARMED")
            }
        }
    }
    pub fn input(&mut self, bytes: &[u8], now: Instant) -> HostResult<InputAck> {
        self.ensure_live(now)?;
        if self.bound_layout.is_none() {
            return Err("REMOTE_MEDIA_LAYOUT_REQUIRED");
        }
        let deadline = self.live_input_deadline(now)?;
        if self.paused {
            return Err("REMOTE_CONTROL_NOT_ALLOWED");
        }
        let mut executor = LiveInput {
            inner: self.input.as_mut(),
            media: self.media.as_mut(),
            expected_layout: self.bound_layout.as_ref().expect("validated media layout"),
            deadline,
            expired: false,
        };
        let result = input::dispatch_input(&mut self.guard, &mut executor, bytes, now);
        let expired = executor.expired;
        match result {
            Ok(ack) => Ok(ack),
            Err(failure) => {
                if let Some(release) = failure.pending_release {
                    self.consume_release(release);
                }
                if expired {
                    self.pause(StopReason::MediaStalled)?;
                    return Err("REMOTE_MEDIA_NOT_LIVE");
                }
                let _ = self.stop(failure.reason);
                Err("REMOTE_INPUT_REJECTED")
            }
        }
    }
    pub fn release_input(&mut self, reason: StopReason) -> HostResult<()> {
        let release = self.guard.release_input(reason);
        self.consume_release(release);
        let result = self.retry_release();
        if result.is_err() {
            let _ = self.stop(reason);
        }
        result
    }
    pub fn pause(&mut self, reason: StopReason) -> HostResult<()> {
        self.paused = true;
        let release = self.guard.pause(reason);
        self.consume_release(release);
        let released = self.retry_release();
        if released.is_err() {
            let _ = self.stop(reason);
        }
        if self.ready {
            let _ = self.send_state("pause", json!({}));
        }
        released
    }

    fn consume_release(&mut self, release: ReleasePlan) {
        self.pending_release.keys.extend(release.keys);
        self.pending_release.buttons.extend(release.buttons);
        self.pending_release.stop_media |= release.stop_media;
    }
    fn retry_release(&mut self) -> HostResult<()> {
        if self.pending_release.keys.is_empty() && self.pending_release.buttons.is_empty() {
            self.pending_release.stop_media = false;
            return Ok(());
        }
        input::apply_release(&self.pending_release, self.input.as_mut())
            .map_err(|_| "REMOTE_INPUT_RELEASE_FAILED")?;
        self.pending_release = ReleasePlan::default();
        Ok(())
    }
    pub fn tick(&mut self, now: Instant) -> HostResult<()> {
        if self.ended {
            return self.stop(self.stop_reason.unwrap_or(StopReason::LocalStop));
        }
        self.ensure_live(now)?;
        let available = (self.probe)();
        if let Some(release) = self.guard.tick(
            now,
            available.capture
                && (self.authority.current_scope() != Scope::Control || available.input),
        ) {
            self.consume_release(release);
            let _ = self.stop(StopReason::SystemUnavailable);
            return Err("REMOTE_GUARD_EXPIRED");
        }
        if self.ready
            && self.last_state_sent.map_or(true, |sent| {
                now.saturating_duration_since(sent) >= Duration::from_secs(1)
            })
        {
            self.send_state("heartbeat", json!({}))?;
            self.last_state_sent = Some(now);
        }
        if self.guard.context().is_some()
            && self.last_window_sent.map_or(true, |sent| {
                now.saturating_duration_since(sent) >= Duration::from_millis(100)
            })
        {
            self.publish_window(now)?;
        }
        Ok(())
    }
    pub fn stop(&mut self, reason: StopReason) -> HostResult<()> {
        if self.ended {
            let released = self.retry_release();
            let terminated = if self.process_terminated {
                Ok(())
            } else {
                let result = self.media.terminate();
                self.process_terminated = result.is_ok();
                result
            };
            return released.and(terminated);
        }
        if self.ready {
            let _ = self.send_state("end", json!({}));
        }
        self.ended = true;
        self.stop_reason = Some(reason);
        self.authority.stop();
        if let Ok(mut state) = self.identity.lock() {
            state.end_runtime(self.generation, &self.local.session_id);
        }
        let release = self.guard.stop(reason);
        self.consume_release(release);
        let released = self.retry_release();
        let _ = self.media.stop_media();
        self.media_started = false;
        let terminated = self.media.terminate();
        self.process_terminated = terminated.is_ok();
        released.and(terminated)
    }
    fn send_state(&mut self, kind: &str, payload: Value) -> HostResult<()> {
        let message = json!({"version":1,"sessionId":self.local.session_id,"negotiationId":self.negotiation_id,
            "connectionGeneration":self.local.host.generation,"type":kind,"payload":payload});
        self.media.send_channel(
            "rc-state-v1",
            &serde_json::to_vec(&message).map_err(|_| "REMOTE_STATE_REJECTED")?,
        )
    }
    fn publish_window(&mut self, now: Instant) -> HostResult<()> {
        let window = self.input_window(now)?;
        self.send_state(
            "input-window",
            serde_json::to_value(window).map_err(|_| "REMOTE_STATE_REJECTED")?,
        )?;
        self.last_window_sent = Some(now);
        Ok(())
    }
    /// Called only for rc-state-v1 bytes from the authenticated engine/DTLS peer.
    pub fn state_message(&mut self, bytes: &[u8], now: Instant) -> HostResult<()> {
        self.state_message_received(bytes, now, now)
    }
    pub fn state_message_received(
        &mut self,
        bytes: &[u8],
        received_at: Instant,
        now: Instant,
    ) -> HostResult<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct StateMessage {
            version: u32,
            session_id: String,
            negotiation_id: String,
            connection_generation: u64,
            #[serde(rename = "type")]
            kind: String,
            #[serde(deserialize_with = "super::ipc::strict_json")]
            payload: Value,
        }
        if bytes.len() > 4096 {
            let _ = self.stop(StopReason::OversizedInput);
            return Err("REMOTE_STATE_REJECTED");
        }
        let result = (|| {
            if received_at > now || now.duration_since(received_at) >= HEARTBEAT_TIMEOUT {
                return Err("REMOTE_CHANNEL_EXPIRED");
            }
            self.ensure_live(now)?;
            let message: StateMessage =
                serde_json::from_slice(bytes).map_err(|_| "REMOTE_STATE_REJECTED")?;
            if message.version != 1
                || message.session_id != self.local.session_id
                || message.negotiation_id != self.negotiation_id
                || message.connection_generation != self.local.controller.generation
                || !message.payload.is_object()
            {
                return Err("REMOTE_STATE_BINDING");
            }
            let payload = &message.payload;
            match message.kind.as_str() {
                "hello" => {
                    if self.ready || payload.as_object().unwrap().len() != 1 {
                        return Err("REMOTE_HANDSHAKE_REPLAY");
                    }
                    let proof: SignedEnvelope = serde_json::from_value(
                        payload
                            .get("proof")
                            .cloned()
                            .ok_or("REMOTE_HANDSHAKE_PROOF")?,
                    )
                    .map_err(|_| "REMOTE_HANDSHAKE_PROOF")?;
                    if proof != self.connection {
                        return Err("REMOTE_HANDSHAKE_PROOF");
                    }
                    self.controller_heartbeat_received(received_at, now)?;
                    self.ready(now)?;
                    self.send_state("hello", json!({"proofSignature":self.connection.signature}))?;
                    self.send_state("heartbeat", json!({}))?;
                    self.last_state_sent = Some(now);
                }
                "heartbeat" => {
                    if !self.ready {
                        return Err("REMOTE_HANDSHAKE_REQUIRED");
                    }
                    if payload.as_object().unwrap().len() != 1
                        || !payload["renderedFrames"]
                            .as_u64()
                            .is_some_and(|n| n <= 9_007_199_254_740_991)
                    {
                        return Err("REMOTE_STATE_REJECTED");
                    }
                    self.controller_heartbeat_received(received_at, now)?;
                    self.liveness
                        .rendered(payload["renderedFrames"].as_u64().unwrap(), received_at)?;
                    self.check_media_liveness(now)?;
                }
                "input-arm" => {
                    if payload.as_object().unwrap().len() != 3
                        || !payload["requestId"]
                            .as_str()
                            .is_some_and(super::authorization::uuid)
                        || payload["controlEpoch"].as_u64()
                            != self
                                .latest_lease
                                .as_ref()
                                .map(|lease| lease.control_epoch())
                        || payload["layoutVersion"].as_u64() != Some(self.layout_version)
                    {
                        return Err("REMOTE_STATE_BINDING");
                    }
                    let context = self.arm_input(now)?;
                    let mut response =
                        serde_json::to_value(context).map_err(|_| "REMOTE_STATE_REJECTED")?;
                    response["requestId"] = payload["requestId"].clone();
                    self.send_state("input-armed", response)?;
                    self.publish_window(now)?;
                }
                "release-all" => {
                    if payload.as_object().unwrap().len() != 5
                        || !payload["reason"]
                            .as_str()
                            .is_some_and(|reason| !reason.is_empty() && reason.len() <= 128)
                        || payload["sessionId"] != self.local.session_id
                        || ["controlEpoch", "inputEpoch", "layoutVersion"]
                            .iter()
                            .any(|key| {
                                !payload[key]
                                    .as_u64()
                                    .is_some_and(|n| n <= 9_007_199_254_740_991)
                            })
                    {
                        return Err("REMOTE_STATE_REJECTED");
                    }
                    if let Some(context) = self.guard.context() {
                        if payload["sessionId"] != context.session_id
                            || payload["controlEpoch"].as_u64() != Some(context.control_epoch)
                            || payload["inputEpoch"].as_u64() != Some(context.input_epoch)
                            || payload["layoutVersion"].as_u64() != Some(context.layout_version)
                        {
                            return Err("REMOTE_STATE_BINDING");
                        }
                        self.release_input(StopReason::LocalStop)?;
                    }
                }
                "pause" => {
                    if !payload.as_object().unwrap().is_empty() {
                        return Err("REMOTE_STATE_REJECTED");
                    }
                    self.pause(StopReason::LocalStop)?;
                }
                "end" => {
                    if !payload.as_object().unwrap().is_empty() {
                        return Err("REMOTE_STATE_REJECTED");
                    }
                    self.stop(StopReason::LocalStop)?;
                }
                _ => return Err("REMOTE_STATE_REJECTED"),
            }
            Ok(())
        })();
        if result.is_err()
            && !matches!(
                result,
                Err("REMOTE_MEDIA_NOT_LIVE"
                    | "REMOTE_CONTROL_NOT_ALLOWED"
                    | "REMOTE_MEDIA_LAYOUT_REQUIRED")
            )
        {
            let _ = self.stop(StopReason::ProtocolMismatch);
        }
        result
    }
    pub fn input_message(&mut self, bytes: &[u8], now: Instant) -> HostResult<()> {
        let ack = match self.input(bytes, now) {
            Ok(ack) => ack,
            Err("REMOTE_MEDIA_NOT_LIVE" | "REMOTE_CONTROL_NOT_ALLOWED")
                if self.paused && !self.ended =>
            {
                if input::validate_suspended_input(
                    bytes,
                    &self.local.session_id,
                    self.latest_lease
                        .as_ref()
                        .map_or(0, |lease| lease.control_epoch()),
                    self.layout_version,
                    self.highest_issued_input_epoch,
                )
                .is_err()
                {
                    let _ = self.stop(StopReason::InvalidInput);
                    return Err("REMOTE_INPUT_REJECTED");
                }
                // The independent release path has already revoked the epoch.
                // Drop a queued frame without ACK; keep view until its own end.
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.send_state(
            "input-ack",
            serde_json::to_value(ack).map_err(|_| "REMOTE_STATE_REJECTED")?,
        )
    }
    pub fn is_ready(&self) -> bool {
        self.ready
    }
    pub fn media_started(&self) -> bool {
        self.media_started
    }
    pub fn media_health(&self) -> MediaHealth {
        self.media_health
    }
    pub fn ended(&self) -> bool {
        self.ended
    }
    pub fn stop_reason(&self) -> Option<StopReason> {
        self.stop_reason
    }
    /// Adapters may observe one last queued command after the watchdog ends a
    /// session. Only independently established expiry is a normal completion;
    /// an IPC, authorization or engine failure must never be hidden by this.
    pub fn expected_terminal_error(&self, error: &str) -> bool {
        if !self.ended {
            return false;
        }
        match self.stop_reason {
            Some(StopReason::LeaseExpired | StopReason::ConsentExpired) => {
                matches!(error, "REMOTE_AUTHORITY_EXPIRED" | "REMOTE_SESSION_ENDED")
            }
            Some(StopReason::MediaStalled) => matches!(
                error,
                "REMOTE_MEDIA_FROZEN" | "REMOTE_AUTHORITY_EXPIRED" | "REMOTE_SESSION_ENDED"
            ),
            _ => false,
        }
    }
}
impl Drop for HostRuntime {
    fn drop(&mut self) {
        for attempt in 0..3 {
            if self.stop(StopReason::LocalStop).is_ok() {
                return;
            }
            if attempt < 2 {
                thread::sleep(Duration::from_millis(20));
            }
        }
        eprintln!("remote_control_cleanup_incomplete");
    }
}

/// Watchdog ownership is native and independent from UI/event/DataChannel loops.
/// Failed key releases retain their ledger and are retried on subsequent ticks.
pub(super) struct HostSupervisor {
    runtime: Arc<Mutex<HostRuntime>>,
    shutdown: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}
impl HostSupervisor {
    pub fn spawn(runtime: HostRuntime) -> Self {
        let runtime = Arc::new(Mutex::new(runtime));
        let worker_runtime = runtime.clone();
        let (shutdown, receive) = mpsc::channel();
        let worker = thread::spawn(move || loop {
            match receive.recv_timeout(WATCHDOG_INTERVAL) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let mut host = worker_runtime.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = host.tick(Instant::now());
                }
            }
        });
        Self {
            runtime,
            shutdown,
            worker: Some(worker),
        }
    }
    pub fn runtime(&self) -> Arc<Mutex<HostRuntime>> {
        self.runtime.clone()
    }
    pub fn stop(&mut self, reason: StopReason) -> HostResult<()> {
        // Keep the watchdog running if an OS release needs another attempt.
        self.runtime
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .stop(reason)?;
        self.shutdown_worker();
        Ok(())
    }
    fn shutdown_worker(&mut self) {
        let _ = self.shutdown.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for HostSupervisor {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            for attempt in 0..3 {
                if runtime.stop(StopReason::LocalStop).is_ok() {
                    break;
                }
                if attempt < 2 {
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
        self.shutdown_worker();
    }
}

#[cfg(test)]
#[path = "host_runtime_tests.rs"]
mod tests;
