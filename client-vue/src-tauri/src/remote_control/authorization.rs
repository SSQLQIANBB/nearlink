//! Signed server authority for the native supervisor. Only signed envelopes
//! may arrive through invoke. LocalConsent must come from the trusted local
//! UI, and ObservedTransport from the native PeerConnection, not the webview.
//! This module verifies authority; it does not start capture or arm OS input.
#![allow(dead_code)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub(super) const DOMAIN: &str = "todesk-remote-control/v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_LEASE: Duration = Duration::from_secs(15);

#[derive(Debug, PartialEq, Eq)]
pub enum AuthorityError {
    InvalidCredential,
    UntrustedKey,
    Expired,
    BindingMismatch,
    ConsentRequired,
    ChallengeMismatch,
    Replay,
    Ended,
    RandomUnavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedEnvelope {
    pub(super) format: String,
    pub(super) key_id: String,
    pub(super) payload: String,
    pub(super) signature: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedKey {
    key_id: String,
    public_key: String,
    not_before: u64,
    not_after: u64,
}

#[derive(Clone)]
pub struct PinnedKeys(Vec<PinnedKey>);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub(super) user_id: u64,
    pub(super) sid: String,
    pub(super) auth_version: String,
    pub(super) endpoint_id: String,
    pub(super) connection_id: String,
    pub(super) generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    View,
    Control,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Purpose {
    Connection,
    Lease,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claims {
    protocol_version: u32,
    issuer: String,
    audience: String,
    purpose: Purpose,
    session_id: String,
    host: Endpoint,
    controller: Endpoint,
    negotiation_id: String,
    host_fingerprint: String,
    controller_fingerprint: String,
    consent_nonce: String,
    screen_id: String,
    scope: Scope,
    authorization_revision: u64,
    control_epoch: u64,
    issued_at: u64,
    expires_at: u64,
    lease_seq: Option<u64>,
    challenge: Option<String>,
}

pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c))
}
pub(super) fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub(super) fn positive(value: u64) -> bool {
    value > 0 && value <= MAX_SAFE_INTEGER
}
pub(super) fn decode(value: &str, length: Option<usize>) -> Result<Vec<u8>, AuthorityError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AuthorityError::InvalidCredential)?;
    if length.is_some_and(|len| bytes.len() != len) || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(AuthorityError::InvalidCredential);
    }
    Ok(bytes)
}
fn fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}
impl Endpoint {
    pub(super) fn valid(&self) -> bool {
        positive(self.user_id)
            && positive(self.generation)
            && uuid(&self.sid)
            && uuid(&self.auth_version)
            && identifier(&self.endpoint_id)
            && identifier(&self.connection_id)
    }
}

impl PinnedKeys {
    pub(super) fn has_current_key(&self, now_ms: u64) -> bool {
        self.0
            .iter()
            .any(|key| now_ms >= key.not_before && now_ms < key.not_after)
    }
    /// Call only with keys from the signed application/deployment configuration.
    /// No network URL or key embedded in a credential is a source of trust.
    pub fn new(keys: Vec<PinnedKey>) -> Result<Self, AuthorityError> {
        if keys.is_empty() || keys.len() > 2 {
            return Err(AuthorityError::UntrustedKey);
        }
        for (index, key) in keys.iter().enumerate() {
            if !identifier(&key.key_id)
                || key.not_after <= key.not_before
                || key.not_after > MAX_SAFE_INTEGER
                || keys[..index].iter().any(|old| old.key_id == key.key_id)
            {
                return Err(AuthorityError::UntrustedKey);
            }
            let bytes: [u8; 32] = decode(&key.public_key, Some(32))?.try_into().unwrap();
            let public =
                VerifyingKey::from_bytes(&bytes).map_err(|_| AuthorityError::UntrustedKey)?;
            if public.is_weak() {
                return Err(AuthorityError::UntrustedKey);
            }
        }
        Ok(Self(keys))
    }

    pub(super) fn verify_payload(
        &self,
        envelope: &SignedEnvelope,
        now_ms: u64,
    ) -> Result<(Vec<u8>, u64, u64), AuthorityError> {
        let (payload, before, after) = self.verify_signature(envelope)?;
        if now_ms < before || now_ms >= after {
            return Err(AuthorityError::Expired);
        }
        Ok((payload, before, after))
    }

    /// Authentication only. Callers must validate the signed purpose, bindings,
    /// key interval and lifetime before using the payload as authority.
    pub(super) fn verify_signature(
        &self,
        envelope: &SignedEnvelope,
    ) -> Result<(Vec<u8>, u64, u64), AuthorityError> {
        if envelope.format != "rc-signed-v1"
            || envelope.payload.len() > 16_384
            || envelope.signature.len() != 86
        {
            return Err(AuthorityError::InvalidCredential);
        }
        let key = self
            .0
            .iter()
            .find(|k| k.key_id == envelope.key_id)
            .ok_or(AuthorityError::UntrustedKey)?;
        let payload = decode(&envelope.payload, None)?;
        let signature_bytes: [u8; 64] = decode(&envelope.signature, Some(64))?.try_into().unwrap();
        let key_bytes: [u8; 32] = decode(&key.public_key, Some(32))?.try_into().unwrap();
        let public =
            VerifyingKey::from_bytes(&key_bytes).map_err(|_| AuthorityError::UntrustedKey)?;
        let message = format!("{DOMAIN}\n{}\n{}", envelope.key_id, envelope.payload);
        public
            .verify_strict(message.as_bytes(), &Signature::from_bytes(&signature_bytes))
            .map_err(|_| AuthorityError::InvalidCredential)?;
        Ok((payload, key.not_before, key.not_after))
    }

    fn verify(
        &self,
        envelope: &SignedEnvelope,
        purpose: Purpose,
        now_ms: u64,
    ) -> Result<Claims, AuthorityError> {
        let (payload, not_before, not_after) = self.verify_payload(envelope, now_ms)?;
        let claims: Claims =
            serde_json::from_slice(&payload).map_err(|_| AuthorityError::InvalidCredential)?;
        if claims.protocol_version != 1
            || claims.issuer != "todesk-remote-control"
            || claims.audience != "todesk-remote-peer"
            || claims.purpose != purpose
            || !uuid(&claims.session_id)
            || !uuid(&claims.negotiation_id)
            || !claims.host.valid()
            || !claims.controller.valid()
            || !fingerprint(&claims.host_fingerprint)
            || !fingerprint(&claims.controller_fingerprint)
            || claims.screen_id.is_empty()
            || claims.screen_id.encode_utf16().count() > 128
            || !positive(claims.authorization_revision)
            || claims.control_epoch > MAX_SAFE_INTEGER
            || decode(&claims.consent_nonce, Some(32)).is_err()
        {
            return Err(AuthorityError::InvalidCredential);
        }
        if claims.issued_at > now_ms
            || claims.issued_at < not_before
            || claims.expires_at <= now_ms
            || claims.expires_at > not_after
            || claims.expires_at > MAX_SAFE_INTEGER
            || claims.expires_at.saturating_sub(claims.issued_at)
                > if purpose == Purpose::Lease {
                    15_000
                } else {
                    30_000
                }
        {
            return Err(AuthorityError::Expired);
        }
        match purpose {
            Purpose::Connection if claims.lease_seq.is_some() || claims.challenge.is_some() => {
                return Err(AuthorityError::InvalidCredential)
            }
            Purpose::Lease
                if !claims.lease_seq.is_some_and(positive)
                    || claims
                        .challenge
                        .as_ref()
                        .map_or(true, |s| decode(s, Some(32)).is_err()) =>
            {
                return Err(AuthorityError::InvalidCredential)
            }
            _ => {}
        }
        Ok(claims)
    }
}

/// In-memory local approval. Restarting the supervisor discards this record.
#[derive(Clone, Debug)]
pub struct LocalConsent {
    pub session_id: String,
    pub host: Endpoint,
    pub controller: Endpoint,
    pub consent_nonce: String,
    pub screen_id: String,
    pub scope: Scope,
    pub authorization_revision: u64,
    pub control_epoch: u64,
    pub deadline: Instant,
    pub server_expires_at: u64,
}

/// Populated from the actual native PeerConnection's negotiated fingerprints.
#[derive(Clone)]
pub struct ObservedTransport {
    pub negotiation_id: String,
    pub host_fingerprint: String,
    pub controller_fingerprint: String,
}

struct PendingChallenge {
    value: String,
    sequence: u64,
    sent: Instant,
}
#[derive(Debug)]
pub struct LeaseChallenge {
    pub challenge: String,
    pub lease_seq: u64,
}

/// A private constructor prevents a caller from treating an ordinary state/ACK
/// as a verified lease. Installation must still leave the input gate unarmed.
#[derive(Debug, Clone)]
pub struct VerifiedLease {
    session_id: String,
    deadline: Instant,
    scope: Scope,
    authorization_revision: u64,
    control_epoch: u64,
    lease_seq: u64,
    consent: LocalConsent,
}
impl VerifiedLease {
    pub fn matches_consent(&self, consent: &LocalConsent) -> bool {
        self.consent.session_id == consent.session_id
            && self.consent.host == consent.host
            && self.consent.controller == consent.controller
            && self.consent.consent_nonce == consent.consent_nonce
            && self.consent.screen_id == consent.screen_id
            && consent.deadline <= self.consent.deadline
            && consent.server_expires_at <= self.consent.server_expires_at
    }
    pub fn lease_seq(&self) -> u64 {
        self.lease_seq
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn scope(&self) -> Scope {
        self.scope
    }
    pub fn authorization_revision(&self) -> u64 {
        self.authorization_revision
    }
    pub fn control_epoch(&self) -> u64 {
        self.control_epoch
    }
}

pub struct LeaseAuthority {
    keys: PinnedKeys,
    consent: LocalConsent,
    transport: ObservedTransport,
    pending: Option<PendingChallenge>,
    next_sequence: u64,
    highest_revision: u64,
    highest_epoch: u64,
    live_deadline: Instant,
    has_media_lease: bool,
    current_scope: Scope,
    ended: bool,
}

fn binding_matches(claims: &Claims, local: &LocalConsent, transport: &ObservedTransport) -> bool {
    claims.session_id == local.session_id
        && claims.host == local.host
        && claims.controller == local.controller
        && claims.screen_id == local.screen_id
        && claims.consent_nonce == local.consent_nonce
        && claims.negotiation_id == transport.negotiation_id
        && claims.host_fingerprint == transport.host_fingerprint
        && claims.controller_fingerprint == transport.controller_fingerprint
}

impl LeaseAuthority {
    pub(super) fn deadline(&self) -> Instant {
        self.live_deadline.min(self.consent.deadline)
    }
    pub(super) fn current_scope(&self) -> Scope {
        self.current_scope
    }
    pub fn verify_connection(
        keys: PinnedKeys,
        envelope: &SignedEnvelope,
        consent: LocalConsent,
        transport: ObservedTransport,
        now_ms: u64,
        now: Instant,
    ) -> Result<Self, AuthorityError> {
        if now >= consent.deadline {
            return Err(AuthorityError::ConsentRequired);
        }
        let claims = keys.verify(envelope, Purpose::Connection, now_ms)?;
        if !binding_matches(&claims, &consent, &transport) {
            return Err(AuthorityError::BindingMismatch);
        }
        if claims.authorization_revision != consent.authorization_revision
            || claims.control_epoch != consent.control_epoch
            || (claims.scope == Scope::Control && consent.scope != Scope::Control)
        {
            return Err(AuthorityError::ConsentRequired);
        }
        let live_deadline = now
            .checked_add(Duration::from_millis(claims.expires_at - now_ms))
            .ok_or(AuthorityError::Expired)?
            .min(consent.deadline);
        Ok(Self {
            keys,
            consent,
            transport,
            pending: None,
            next_sequence: 1,
            highest_revision: claims.authorization_revision,
            highest_epoch: claims.control_epoch,
            live_deadline,
            has_media_lease: false,
            current_scope: claims.scope,
            ended: false,
        })
    }

    pub fn challenge(&mut self, now: Instant) -> Result<LeaseChallenge, AuthorityError> {
        if self.ended || now >= self.consent.deadline || now >= self.live_deadline {
            self.stop();
            return Err(AuthorityError::Ended);
        }
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|_| AuthorityError::RandomUnavailable)?;
        self.install_challenge(URL_SAFE_NO_PAD.encode(bytes), now)
    }

    fn install_challenge(
        &mut self,
        value: String,
        now: Instant,
    ) -> Result<LeaseChallenge, AuthorityError> {
        if !positive(self.next_sequence) {
            self.stop();
            return Err(AuthorityError::Ended);
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.pending = Some(PendingChallenge {
            value: value.clone(),
            sequence,
            sent: now,
        });
        Ok(LeaseChallenge {
            challenge: value,
            lease_seq: sequence,
        })
    }

    pub fn accept_lease(
        &mut self,
        envelope: &SignedEnvelope,
        now_ms: u64,
        now: Instant,
    ) -> Result<VerifiedLease, AuthorityError> {
        let result = self.accept(envelope, now_ms, now);
        // A failed proof cannot leave a previous live authority reusable.
        if result.is_err() {
            self.stop();
        }
        result
    }
    fn accept(
        &mut self,
        envelope: &SignedEnvelope,
        now_ms: u64,
        now: Instant,
    ) -> Result<VerifiedLease, AuthorityError> {
        if self.ended {
            return Err(AuthorityError::Ended);
        }
        if now >= self.consent.deadline || now >= self.live_deadline {
            return Err(AuthorityError::ConsentRequired);
        }
        let claims = self.keys.verify(envelope, Purpose::Lease, now_ms)?;
        if !binding_matches(&claims, &self.consent, &self.transport) {
            return Err(AuthorityError::BindingMismatch);
        }
        if claims.authorization_revision < self.highest_revision
            || claims.control_epoch < self.highest_epoch
            || (self.has_media_lease
                && claims.scope != self.current_scope
                && (claims.authorization_revision <= self.highest_revision
                    || claims.control_epoch <= self.highest_epoch))
        {
            return Err(AuthorityError::Replay);
        }
        if claims.scope == Scope::Control
            && (self.consent.scope != Scope::Control
                || claims.authorization_revision != self.consent.authorization_revision
                || claims.control_epoch != self.consent.control_epoch)
        {
            return Err(AuthorityError::ConsentRequired);
        }
        let pending = self
            .pending
            .as_ref()
            .ok_or(AuthorityError::ChallengeMismatch)?;
        if claims.challenge.as_deref() != Some(pending.value.as_str())
            || claims.lease_seq != Some(pending.sequence)
        {
            return Err(AuthorityError::ChallengeMismatch);
        }
        let ttl = Duration::from_millis(claims.expires_at - claims.issued_at).min(MAX_LEASE);
        let deadline = pending
            .sent
            .checked_add(ttl)
            .ok_or(AuthorityError::Expired)?
            .min(self.consent.deadline);
        if now < pending.sent || now >= deadline {
            return Err(AuthorityError::Expired);
        }
        self.pending = None;
        self.highest_revision = claims.authorization_revision;
        self.highest_epoch = claims.control_epoch;
        self.live_deadline = deadline;
        self.has_media_lease = true;
        self.current_scope = claims.scope;
        Ok(VerifiedLease {
            session_id: claims.session_id,
            scope: claims.scope,
            deadline,
            authorization_revision: claims.authorization_revision,
            control_epoch: claims.control_epoch,
            lease_seq: claims.lease_seq.unwrap(),
            consent: self.consent.clone(),
        })
    }

    /// Called only after a new trusted local approval while the same live
    /// session is view-only. It cannot replace endpoints, extend the absolute
    /// local session deadline or arm input. A fresh signed lease is still needed.
    pub fn replace_local_consent(
        &mut self,
        next: LocalConsent,
        now: Instant,
    ) -> Result<(), AuthorityError> {
        if self.ended || now >= self.live_deadline || now >= self.consent.deadline {
            self.stop();
            return Err(AuthorityError::Ended);
        }
        if !self.has_media_lease
            || self.current_scope != Scope::View
            || next.scope != Scope::Control
            || next.session_id != self.consent.session_id
            || next.host != self.consent.host
            || next.controller != self.consent.controller
            || next.screen_id != self.consent.screen_id
            || next.consent_nonce == self.consent.consent_nonce
            || decode(&next.consent_nonce, Some(32)).is_err()
            || next.authorization_revision <= self.highest_revision
            || !positive(next.authorization_revision)
            || next.control_epoch <= self.highest_epoch
            || !positive(next.control_epoch)
            || next.deadline > self.consent.deadline
            || now >= next.deadline
        {
            return Err(AuthorityError::ConsentRequired);
        }
        self.consent = next;
        self.pending = None;
        Ok(())
    }

    pub fn stop(&mut self) {
        self.ended = true;
        self.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::Value;
    const FIXTURE: &str = include_str!("../../../../fixtures/remote-control-credentials-v1.json");

    fn fixture() -> (
        Value,
        PinnedKeys,
        SignedEnvelope,
        SignedEnvelope,
        LocalConsent,
        ObservedTransport,
        Instant,
    ) {
        let f: Value = serde_json::from_str(FIXTURE).unwrap();
        let keys =
            PinnedKeys::new(vec![serde_json::from_value(f["key"].clone()).unwrap()]).unwrap();
        let connection: SignedEnvelope = serde_json::from_value(f["connection"].clone()).unwrap();
        let lease: SignedEnvelope = serde_json::from_value(f["lease"].clone()).unwrap();
        let c: Claims = serde_json::from_value(f["claims"].clone()).unwrap();
        let now = Instant::now();
        let consent = LocalConsent {
            session_id: c.session_id,
            host: c.host,
            controller: c.controller,
            consent_nonce: c.consent_nonce,
            screen_id: c.screen_id,
            scope: c.scope,
            authorization_revision: c.authorization_revision,
            control_epoch: c.control_epoch,
            deadline: now + Duration::from_secs(60),
            server_expires_at: c.issued_at + 60_000,
        };
        let transport = ObservedTransport {
            negotiation_id: c.negotiation_id,
            host_fingerprint: c.host_fingerprint,
            controller_fingerprint: c.controller_fingerprint,
        };
        (f, keys, connection, lease, consent, transport, now)
    }
    fn change(envelope: &SignedEnvelope, edit: impl FnOnce(&mut Value)) -> SignedEnvelope {
        // RFC 8032 public test vector seed, never a deployment key.
        let seed = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ];
        let mut claims: Value =
            serde_json::from_slice(&decode(&envelope.payload, None).unwrap()).unwrap();
        edit(&mut claims);
        let mut result = envelope.clone();
        result.payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let message = format!("{DOMAIN}\n{}\n{}", result.key_id, result.payload);
        result.signature = URL_SAFE_NO_PAD.encode(
            SigningKey::from_bytes(&seed)
                .sign(message.as_bytes())
                .to_bytes(),
        );
        result
    }
    #[test]
    fn node_signed_connection_and_lease_verify_in_rust() {
        let (f, keys, connection, lease, consent, transport, now) = fixture();
        let ms = f["now"].as_u64().unwrap();
        let mut authority =
            LeaseAuthority::verify_connection(keys, &connection, consent, transport, ms, now)
                .unwrap();
        authority
            .install_challenge(URL_SAFE_NO_PAD.encode([2u8; 32]), now)
            .unwrap();
        let verified = authority
            .accept_lease(&lease, ms + 5000, now + Duration::from_secs(5))
            .unwrap();
        assert_eq!(verified.deadline(), now + MAX_LEASE);
        assert_eq!(verified.scope(), Scope::Control);
        assert!(authority
            .accept_lease(&lease, ms + 5001, now + Duration::from_secs(5))
            .is_err());
        assert_eq!(authority.challenge(now).unwrap_err(), AuthorityError::Ended);
    }
    #[test]
    fn fingerprints_endpoint_identity_and_local_consent_are_all_required() {
        for field in 0..6 {
            let (f, keys, connection, _, mut consent, mut transport, now) = fixture();
            match field {
                0 => consent.host.generation += 1,
                1 => consent.controller.sid = consent.host.sid.clone(),
                2 => consent.scope = Scope::View,
                3 => consent.consent_nonce = URL_SAFE_NO_PAD.encode([8u8; 32]),
                4 => transport.controller_fingerprint = "EF".repeat(32),
                _ => consent.deadline = now,
            }
            assert!(LeaseAuthority::verify_connection(
                keys,
                &connection,
                consent,
                transport,
                f["now"].as_u64().unwrap(),
                now
            )
            .is_err());
        }
    }
    #[test]
    fn signed_but_wrong_purpose_unknown_fields_scope_or_key_are_rejected() {
        let (f, keys, connection, _, _, _, _) = fixture();
        let ms = f["now"].as_u64().unwrap();
        for token in [
            change(&connection, |c| c["audience"] = "other".into()),
            change(&connection, |c| c["extra"] = true.into()),
            change(&connection, |c| c["expiresAt"] = (ms + 30_001).into()),
            change(&connection, |c| c["leaseSeq"] = 1.into()),
            change(&connection, |c| c["host"]["generation"] = 0.into()),
        ] {
            assert!(keys.verify(&token, Purpose::Connection, ms).is_err());
        }
        let mut tampered = connection.clone();
        tampered.key_id = "unknown".into();
        assert!(keys.verify(&tampered, Purpose::Connection, ms).is_err());
        tampered = connection.clone();
        tampered.signature = URL_SAFE_NO_PAD.encode([0u8; 64]);
        assert!(keys.verify(&tampered, Purpose::Connection, ms).is_err());
        assert!(keys.verify(&connection, Purpose::Lease, ms).is_err());
    }
    #[test]
    fn local_monotonic_deadline_defeats_delayed_response_and_clock_rollback() {
        let (f, keys, connection, lease, consent, transport, now) = fixture();
        let ms = f["now"].as_u64().unwrap();
        let mut authority =
            LeaseAuthority::verify_connection(keys, &connection, consent, transport, ms, now)
                .unwrap();
        authority
            .install_challenge(URL_SAFE_NO_PAD.encode([2u8; 32]), now)
            .unwrap();
        assert_eq!(
            authority
                .accept_lease(&lease, ms, now + MAX_LEASE)
                .unwrap_err(),
            AuthorityError::Expired
        );
    }
    #[test]
    fn new_challenge_supersedes_old_and_pause_cannot_restore_control() {
        let (f, keys, connection, lease, consent, transport, now) = fixture();
        let ms = f["now"].as_u64().unwrap();
        let mut authority =
            LeaseAuthority::verify_connection(keys, &connection, consent, transport, ms, now)
                .unwrap();
        authority
            .install_challenge(URL_SAFE_NO_PAD.encode([2u8; 32]), now)
            .unwrap();
        let downgrade = change(&lease, |c| {
            c["scope"] = "view".into();
            c["authorizationRevision"] = 2.into();
            c["controlEpoch"] = 2.into();
        });
        assert_eq!(
            authority.accept_lease(&downgrade, ms, now).unwrap().scope(),
            Scope::View
        );
        authority
            .install_challenge(URL_SAFE_NO_PAD.encode([3u8; 32]), now)
            .unwrap();
        let restore = change(&lease, |c| {
            c["leaseSeq"] = 2.into();
            c["challenge"] = URL_SAFE_NO_PAD.encode([3u8; 32]).into();
            c["authorizationRevision"] = 3.into();
            c["controlEpoch"] = 3.into();
        });
        assert_eq!(
            authority.accept_lease(&restore, ms, now).unwrap_err(),
            AuthorityError::ConsentRequired
        );
    }
    #[test]
    fn a_new_local_approval_can_restore_control_on_the_same_transport() {
        let (f, keys, connection, lease, consent, transport, now) = fixture();
        let ms = f["now"].as_u64().unwrap();
        let mut replacement = consent.clone();
        let mut authority =
            LeaseAuthority::verify_connection(keys, &connection, consent, transport, ms, now)
                .unwrap();
        authority
            .install_challenge(URL_SAFE_NO_PAD.encode([2u8; 32]), now)
            .unwrap();
        let downgrade = change(&lease, |c| {
            c["scope"] = "view".into();
            c["authorizationRevision"] = 2.into();
            c["controlEpoch"] = 2.into();
        });
        authority.accept_lease(&downgrade, ms, now).unwrap();
        replacement.consent_nonce = URL_SAFE_NO_PAD.encode([4u8; 32]);
        replacement.authorization_revision = 3;
        replacement.control_epoch = 3;
        authority
            .replace_local_consent(replacement.clone(), now)
            .unwrap();
        authority
            .install_challenge(URL_SAFE_NO_PAD.encode([3u8; 32]), now)
            .unwrap();
        let restore = change(&lease, |c| {
            c["leaseSeq"] = 2.into();
            c["challenge"] = URL_SAFE_NO_PAD.encode([3u8; 32]).into();
            c["authorizationRevision"] = 3.into();
            c["controlEpoch"] = 3.into();
            c["consentNonce"] = replacement.consent_nonce.into();
        });
        assert_eq!(
            authority.accept_lease(&restore, ms, now).unwrap().scope(),
            Scope::Control
        );
    }
    #[test]
    fn lease_timeout_is_terminal_even_when_a_new_valid_signature_arrives() {
        for late_response in [false, true] {
            let (f, keys, connection, lease, consent, transport, now) = fixture();
            let ms = f["now"].as_u64().unwrap();
            let mut authority =
                LeaseAuthority::verify_connection(keys, &connection, consent, transport, ms, now)
                    .unwrap();
            authority
                .install_challenge(URL_SAFE_NO_PAD.encode([2u8; 32]), now)
                .unwrap();
            authority.accept_lease(&lease, ms, now).unwrap();
            if late_response {
                authority
                    .install_challenge(
                        URL_SAFE_NO_PAD.encode([3u8; 32]),
                        now + Duration::from_secs(10),
                    )
                    .unwrap();
                let late = change(&lease, |c| {
                    c["leaseSeq"] = 2.into();
                    c["challenge"] = URL_SAFE_NO_PAD.encode([3u8; 32]).into();
                    c["issuedAt"] = (ms + 10_000).into();
                    c["expiresAt"] = (ms + 25_000).into();
                });
                assert!(authority
                    .accept_lease(&late, ms + 15_001, now + Duration::from_millis(15_001))
                    .is_err());
            } else {
                assert!(authority.challenge(now + MAX_LEASE).is_err());
            }
            assert_eq!(authority.challenge(now).unwrap_err(), AuthorityError::Ended);
        }
    }
    #[test]
    fn keyring_has_bounded_rotation_and_no_empty_or_duplicate_trust() {
        let (f, _, _, _, _, _, _) = fixture();
        let key: PinnedKey = serde_json::from_value(f["key"].clone()).unwrap();
        assert!(PinnedKeys::new(vec![]).is_err());
        assert!(PinnedKeys::new(vec![key.clone(), key]).is_err());
        let key: PinnedKey = serde_json::from_value(f["key"].clone()).unwrap();
        let keys = PinnedKeys::new(vec![key.clone()]).unwrap();
        assert!(!keys.has_current_key(key.not_before - 1));
        assert!(keys.has_current_key(key.not_before));
        assert!(!keys.has_current_key(key.not_after));
    }
}
