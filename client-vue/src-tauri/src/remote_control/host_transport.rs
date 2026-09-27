//! Native negotiation boundary shared by packaged and development adapters.
//! Only authenticated process events can supply observed DTLS/channel state.
//! This module neither accepts OS consent from JavaScript nor enables release.
#![allow(dead_code)]
use super::{
    authorization::{self, ObservedTransport, PinnedKeys, SignedEnvelope},
    host_process::ProcessMediaDriver,
    host_runtime::{AvailabilityProbe, HostResult, HostRuntime, MediaDriver},
    ice::{self, CandidatePolicy},
    identity::{IdentityState, RuntimeClaim},
    input::InputExecutor,
    ipc::IpcMessage,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{mpsc::Receiver, Arc, Mutex},
    time::{Duration, Instant},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const CHANNEL_MAX_AGE: Duration = Duration::from_secs(3);

pub(super) struct PreparedHost {
    pub driver: ProcessMediaDriver,
    pub events: Receiver<IpcMessage>,
    pub transport: HostTransport,
}
impl PreparedHost {
    /// No path, executable arguments, trust roots or test flags come from Vue.
    pub fn bundled(
        app: &tauri::AppHandle,
        identity: Arc<Mutex<IdentityState>>,
    ) -> HostResult<Self> {
        Self::prepare(identity, Instant::now(), |session| {
            ProcessMediaDriver::spawn_bundled(app, session)
        })
    }
    pub fn configure_ice(
        &mut self,
        keys: &PinnedKeys,
        proof: &SignedEnvelope,
        wall: u64,
        now: Instant,
    ) -> HostResult<()> {
        let payload = self.transport.configure_ice(keys, proof, wall, now)?;
        if let Err(error) = self.driver.send("configure-ice", payload) {
            let _ = self.driver.terminate_bounded();
            return Err(error);
        }
        Ok(())
    }
    pub fn prepare(
        identity: Arc<Mutex<IdentityState>>,
        now: Instant,
        launch: impl FnOnce(&str) -> HostResult<(ProcessMediaDriver, Receiver<IpcMessage>)>,
    ) -> HostResult<Self> {
        // Reserve before file verification/process startup. Concurrent launches
        // cannot both negotiate against one local confirmation.
        let transport = HostTransport::reserve(identity, now)?;
        let (driver, events) = launch(transport.session_id())?;
        if let Err(error) = transport.check(Instant::now(), false) {
            let _ = driver.terminate_bounded();
            return Err(error);
        }
        Ok(Self {
            driver,
            events,
            transport,
        })
    }
}

pub(super) struct HostTransport {
    claim: Option<RuntimeClaim>,
    ice_policy: CandidatePolicy,
    ice_configured: bool,
    network_observed: bool,
    identity: Arc<Mutex<IdentityState>>,
    generation: u64,
    session_id: String,
    deadline: Instant,
    negotiation: Option<String>,
    offered_fingerprint: Option<String>,
    answered_fingerprint: Option<String>,
    dtls: Option<ObservedTransport>,
    channels: [bool; 2],
    ready: bool,
    connected: bool,
    incoming_ice: usize,
    outgoing_ice: usize,
    pending: VecDeque<(Instant, String, Vec<u8>)>,
}
impl HostTransport {
    pub fn reserve(identity: Arc<Mutex<IdentityState>>, now: Instant) -> HostResult<Self> {
        let claim = RuntimeClaim::reserve(identity.clone(), now)?;
        Ok(Self {
            generation: claim.generation,
            session_id: claim.local.session_id.clone(),
            deadline: claim.local.deadline.min(now + CONNECT_TIMEOUT),
            claim: Some(claim),
            ice_policy: CandidatePolicy::Loopback,
            ice_configured: false,
            network_observed: false,
            identity,
            negotiation: None,
            offered_fingerprint: None,
            answered_fingerprint: None,
            dtls: None,
            channels: [false; 2],
            ready: false,
            connected: false,
            incoming_ice: 0,
            outgoing_ice: 0,
            pending: VecDeque::new(),
        })
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn belongs_to(&self, identity: &Arc<Mutex<IdentityState>>) -> bool {
        Arc::ptr_eq(&self.identity, identity)
    }
    pub fn check(&self, now: Instant, media_started: bool) -> HostResult<()> {
        if !media_started && now >= self.deadline {
            return Err("REMOTE_CONNECT_TIMEOUT");
        }
        if !self
            .identity
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .runtime_is_current(self.generation, &self.session_id, now)
        {
            return Err("REMOTE_OPERATION_CANCELLED");
        }
        Ok(())
    }
    /// Must be sent over the authenticated inherited pipe before the first offer.
    pub fn configure_ice(
        &mut self,
        keys: &PinnedKeys,
        proof: &SignedEnvelope,
        wall: u64,
        now: Instant,
    ) -> HostResult<Value> {
        self.check(now, false)?;
        if self.ice_configured || self.negotiation.is_some() {
            return Err("REMOTE_ICE_CONFIGURATION_REPLAY");
        }
        let local = &self
            .claim
            .as_ref()
            .ok_or("REMOTE_LOCAL_CONSENT_REQUIRED")?
            .local;
        let (policy, payload) = ice::verify(keys, proof, local, wall, now)?;
        self.ice_policy = policy;
        self.ice_configured = true;
        Ok(payload)
    }
    pub fn offer(&mut self, negotiation: &str, sdp: &str, now: Instant) -> HostResult<Value> {
        self.check(now, false)?;
        if self.negotiation.is_some() || !authorization::uuid(negotiation) {
            return Err("REMOTE_OFFER_REJECTED");
        }
        let fingerprint = sdp_fingerprint_with_policy(sdp, self.ice_policy.remote())?;
        self.negotiation = Some(negotiation.into());
        self.offered_fingerprint = Some(fingerprint);
        Ok(json!({"sdp":sdp}))
    }
    pub fn ice(&mut self, payload: Value, now: Instant, media_started: bool) -> HostResult<Value> {
        self.check(now, media_started)?;
        if self.negotiation.is_none() {
            return Err("REMOTE_OFFER_REQUIRED");
        }
        validate_ice(&payload, self.ice_policy.remote())?;
        if self.incoming_ice >= 128 {
            return Err("REMOTE_ICE_LIMIT");
        }
        self.incoming_ice += 1;
        Ok(payload)
    }
    /// Called only for the MAC-verified inherited-pipe receiver, never invoke.
    pub fn observe(
        &mut self,
        event: &IpcMessage,
        now: Instant,
        media_started: bool,
    ) -> HostResult<()> {
        match event.kind.as_str() {
            "ready" => {
                if self.ready
                    || event.payload["mediaStarted"] != false
                    || event.payload["loopbackOnly"] != true
                {
                    return Err("REMOTE_ENGINE_READY_REJECTED");
                }
                self.ready = true;
            }
            "network-configured" => {
                let expected = if self.ice_policy == CandidatePolicy::Relay {
                    "relay"
                } else {
                    "all"
                };
                if !self.ready
                    || !self.ice_configured
                    || self.network_observed
                    || event.payload != json!({"iceTransportPolicy":expected})
                {
                    return Err("REMOTE_ICE_CONFIGURATION");
                }
                self.network_observed = true;
            }
            "answer" => {
                if !self.ready
                    || (self.ice_configured && !self.network_observed)
                    || self.negotiation.is_none()
                    || self.answered_fingerprint.is_some()
                {
                    return Err("REMOTE_ANSWER_REJECTED");
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Answer {
                    sdp: String,
                }
                let value: Answer = serde_json::from_value(event.payload.clone())
                    .map_err(|_| "REMOTE_ANSWER_REJECTED")?;
                self.answered_fingerprint =
                    Some(sdp_fingerprint_with_policy(&value.sdp, self.ice_policy)?);
            }
            "ice" => {
                if !self.ready || self.negotiation.is_none() || self.outgoing_ice >= 128 {
                    return Err("REMOTE_ICE_LIMIT");
                }
                validate_ice(&event.payload, self.ice_policy)?;
                self.outgoing_ice += 1;
            }
            "dtls" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Dtls {
                    host_fingerprint: String,
                    controller_fingerprint: String,
                }
                let value: Dtls = serde_json::from_value(event.payload.clone())
                    .map_err(|_| "REMOTE_DTLS_REJECTED")?;
                if self.dtls.is_some()
                    || self.offered_fingerprint.as_ref() != Some(&value.controller_fingerprint)
                    || self.answered_fingerprint.as_ref() != Some(&value.host_fingerprint)
                {
                    return Err("REMOTE_DTLS_REJECTED");
                }
                self.dtls = Some(ObservedTransport {
                    negotiation_id: self.negotiation.clone().ok_or("REMOTE_OFFER_REQUIRED")?,
                    host_fingerprint: value.host_fingerprint,
                    controller_fingerprint: value.controller_fingerprint,
                });
            }
            "channel-open" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Channel {
                    label: String,
                }
                let value: Channel = serde_json::from_value(event.payload.clone())
                    .map_err(|_| "REMOTE_CHANNEL_REJECTED")?;
                if !self.ready || self.answered_fingerprint.is_none() {
                    return Err("REMOTE_CHANNEL_REJECTED");
                }
                // Some GStreamer versions report open both on registration and
                // via on-open. An identical observation is idempotent.
                self.channels[channel_index(&value.label)?] = true;
            }
            "channel-data" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Channel {
                    label: String,
                    data: String,
                }
                let value: Channel = serde_json::from_value(event.payload.clone())
                    .map_err(|_| "REMOTE_CHANNEL_REJECTED")?;
                let index = channel_index(&value.label)?;
                if !self.channels[index] || value.data.len() > 5462 || self.pending.len() >= 32 {
                    return Err("REMOTE_CHANNEL_BACKPRESSURE");
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(&value.data)
                    .map_err(|_| "REMOTE_CHANNEL_REJECTED")?;
                if bytes.len() > 4096 || URL_SAFE_NO_PAD.encode(&bytes) != value.data {
                    return Err("REMOTE_CHANNEL_REJECTED");
                }
                if event.received_at > now
                    || now.duration_since(event.received_at) >= CHANNEL_MAX_AGE
                {
                    return Err("REMOTE_CHANNEL_EXPIRED");
                }
                self.pending
                    .push_back((event.received_at, value.label, bytes));
            }
            "media-started" if !self.connected || !media_started => {
                return Err("REMOTE_MEDIA_BEFORE_LEASE")
            }
            "media-progress" | "media-layout" | "media-started" | "stopped" | "error"
            | "pipe-closed" => {}
            #[cfg(feature = "remote-control-harness")]
            "test-fault" => {}
            _ => return Err("REMOTE_ENGINE_EVENT_REJECTED"),
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn connect(
        &mut self,
        keys: PinnedKeys,
        proof: &SignedEnvelope,
        mut media: Box<dyn MediaDriver>,
        input: Box<dyn InputExecutor>,
        probe: AvailabilityProbe,
        now_ms: u64,
        now: Instant,
    ) -> HostResult<HostRuntime> {
        let prepared = (|| {
            self.check(now, false)?;
            if self.connected {
                return Err("REMOTE_CONNECTION_REPLAY");
            }
            let observed = self.dtls.clone().ok_or("REMOTE_NATIVE_DTLS_REQUIRED")?;
            let claim = self.claim.take().ok_or("REMOTE_LOCAL_CONSENT_REQUIRED")?;
            Ok((claim, observed))
        })();
        let (claim, observed) = match prepared {
            Ok(value) => value,
            Err(error) => {
                let _ = media.terminate();
                return Err(error);
            }
        };
        let runtime = HostRuntime::connect_claimed(
            claim, keys, proof, observed, media, input, probe, 1, now_ms, now,
        )?;
        self.connected = true;
        Ok(runtime)
    }
    pub fn drain_channels(&mut self, now: Instant) -> HostResult<Vec<(Instant, String, Vec<u8>)>> {
        if !self.connected {
            return Ok(Vec::new());
        }
        if self
            .pending
            .front()
            .is_some_and(|(at, _, _)| now.saturating_duration_since(*at) >= CHANNEL_MAX_AGE)
        {
            self.pending.clear();
            return Err("REMOTE_CHANNEL_EXPIRED");
        }
        if !self.channels.iter().all(|open| *open) {
            return Ok(Vec::new());
        }
        Ok(self.pending.drain(..).collect())
    }
    pub fn clear_channels(&mut self) {
        self.pending.clear();
    }
    pub fn observed_transport(&self) -> Option<ObservedTransport> {
        self.dtls.clone()
    }
}
fn channel_index(label: &str) -> HostResult<usize> {
    match label {
        "rc-state-v1" => Ok(0),
        "rc-input-v1" => Ok(1),
        _ => Err("REMOTE_CHANNEL_REJECTED"),
    }
}
#[cfg(test)]
fn sdp_fingerprint(sdp: &str) -> HostResult<String> {
    sdp_fingerprint_with_policy(sdp, CandidatePolicy::Loopback)
}
fn sdp_fingerprint_with_policy(sdp: &str, policy: CandidatePolicy) -> HostResult<String> {
    if sdp.is_empty() || sdp.len() > 65536 || sdp.contains('\0') {
        return Err("REMOTE_SDP_REJECTED");
    }
    let mut result = None;
    for line in sdp.lines() {
        if let Some(value) = line.strip_prefix("a=fingerprint:") {
            let value = value
                .strip_prefix("sha-256 ")
                .ok_or("REMOTE_SDP_REJECTED")?;
            let octets: Vec<_> = value.split(':').collect();
            if octets.len() != 32
                || octets
                    .iter()
                    .any(|v| v.len() != 2 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return Err("REMOTE_SDP_REJECTED");
            }
            let value = octets.join("").to_ascii_uppercase();
            if result.as_ref().is_some_and(|old| old != &value) {
                return Err("REMOTE_SDP_REJECTED");
            }
            result = Some(value);
        }
        if let Some(candidate) = line.strip_prefix("a=candidate:") {
            ice::candidate(&format!("candidate:{candidate}"), policy)?;
        }
    }
    result.ok_or("REMOTE_SDP_REJECTED")
}
fn validate_ice(value: &Value, policy: CandidatePolicy) -> HostResult<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Ice {
        candidate: String,
        sdp_m_line_index: u8,
    }
    let value: Ice = serde_json::from_value(value.clone()).map_err(|_| "REMOTE_ICE_REJECTED")?;
    if value.sdp_m_line_index > 2 {
        return Err("REMOTE_ICE_REJECTED");
    }
    ice::candidate(&value.candidate, policy)
}
#[cfg(test)]
fn validate_candidate(candidate: &str) -> HostResult<()> {
    ice::candidate(candidate, CandidatePolicy::Loopback)
}

#[cfg(test)]
#[path = "host_transport_tests.rs"]
mod tests;
