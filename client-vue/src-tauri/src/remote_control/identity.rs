//! Constrained native device proof and local consent. The webview supplies only
//! a registration challenge or server-signed approval envelope, never arbitrary
//! signing bytes, trusted keys, a decision, or a LocalConsent record.
use super::authorization::{
    decode, positive, uuid, Endpoint, LocalConsent, PinnedKey, PinnedKeys, Scope, SignedEnvelope,
    VerifiedLease, DOMAIN,
};
use super::device_store::SeedStore;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const COMPILED_KEYS: &str = include_str!("../../remote-control-trusted-keys.json");
pub(super) fn trusted_keys() -> Result<PinnedKeys, &'static str> {
    let keys: Vec<PinnedKey> =
        serde_json::from_str(COMPILED_KEYS).map_err(|_| "REMOTE_TRUST_NOT_CONFIGURED")?;
    PinnedKeys::new(keys).map_err(|_| "REMOTE_TRUST_NOT_CONFIGURED")
}
pub(super) fn wall_ms() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .filter(|v| *v <= MAX_SAFE)
        .ok_or("REMOTE_CLOCK_INVALID")
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceChallenge {
    id: String,
    nonce: String,
    user_id: u64,
    sid: String,
    action: String,
    expires_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationProof {
    challenge_id: String,
    public_key: String,
    signature: String,
    alias: String,
    platform: &'static str,
}
fn platform() -> Result<&'static str, &'static str> {
    match std::env::consts::OS {
        "macos" => Ok("macos"),
        "windows" => Ok("windows"),
        _ => Err("PLATFORM_UNSUPPORTED"),
    }
}
fn signing_key(
    store: &impl SeedStore,
    user: u64,
    create: bool,
) -> Result<SigningKey, &'static str> {
    let seed = match store.read(user)? {
        Some(value) => value,
        None if create => {
            let mut value = Zeroizing::new(vec![0u8; 32]);
            getrandom::getrandom(&mut value).map_err(|_| "REMOTE_RANDOM_UNAVAILABLE")?;
            store.write(user, &value)?;
            // Confirm persistence before releasing a public identity/proof.
            let stored = store.read(user)?.ok_or("REMOTE_KEYSTORE_UNAVAILABLE")?;
            if *stored != *value {
                return Err("REMOTE_KEYSTORE_INVALID");
            }
            stored
        }
        None => return Err("REMOTE_DEVICE_NOT_REGISTERED"),
    };
    let bytes: &[u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| "REMOTE_KEYSTORE_INVALID")?;
    Ok(SigningKey::from_bytes(bytes))
}
fn public_der(key: &SigningKey) -> Vec<u8> {
    let mut der = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    der.extend_from_slice(&key.verifying_key().to_bytes());
    der
}
fn fingerprint(key: &SigningKey) -> String {
    format!("{:x}", Sha256::digest(public_der(key)))
}
fn canonical(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical(&map[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        serde_json::Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
pub(super) fn register(
    store: &impl SeedStore,
    challenge: DeviceChallenge,
    alias: String,
    now: u64,
) -> Result<RegistrationProof, &'static str> {
    let started = Instant::now();
    let alias = alias.trim().to_owned();
    if !uuid(&challenge.id)
        || !uuid(&challenge.sid)
        || !positive(challenge.user_id)
        || challenge.action != "register-device"
        || decode(&challenge.nonce, Some(32)).is_err()
        || challenge.expires_at <= now
        || challenge.expires_at > now.saturating_add(30_000)
        || alias.is_empty()
        || alias.encode_utf16().count() > 80
        || alias.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err("INVALID_DEVICE_CHALLENGE");
    }
    let platform = platform()?;
    let key = signing_key(store, challenge.user_id, true)?;
    if started.elapsed() >= Duration::from_millis(challenge.expires_at - now) {
        return Err("INVALID_DEVICE_CHALLENGE");
    }
    let public_key = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        STANDARD.encode(public_der(&key))
    );
    let mut message = serde_json::to_value(&challenge).map_err(|_| "INVALID_DEVICE_CHALLENGE")?;
    let map = message.as_object_mut().unwrap();
    map.insert("protocolVersion".into(), 1.into());
    map.insert("publicKey".into(), public_key.clone().into());
    map.insert("alias".into(), alias.clone().into());
    map.insert("platform".into(), platform.into());
    let signature = STANDARD.encode(key.sign(canonical(&message).as_bytes()).to_bytes());
    Ok(RegistrationProof {
        challenge_id: challenge.id,
        public_key,
        signature,
        alias,
        platform,
    })
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApprovalRequest {
    protocol_version: u32,
    issuer: String,
    audience: String,
    purpose: String,
    approval_id: String,
    action: String,
    session_id: String,
    host: Endpoint,
    controller: Endpoint,
    requested_scope: Scope,
    authorization_revision: u64,
    control_epoch: u64,
    host_key_version: u64,
    host_key_fingerprint: String,
    screen_id: String,
    issued_at: u64,
    expires_at: u64,
    session_expires_at: u64,
}
pub(super) struct VerifiedApproval {
    claims: ApprovalRequest,
    key: SigningKey,
    received: Instant,
    deadline: Instant,
    session_deadline: Instant,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    View,
    Control,
    Reject,
}
#[derive(Serialize)]
pub struct ConsentResponse {
    consent: SignedEnvelope,
}
#[derive(Default)]
pub(super) struct IdentityState {
    generation: u64,
    pending: Option<u64>,
    next_ticket: u64,
    used: HashMap<String, Instant>,
    consent: Option<LocalConsent>,
    runtime_claimed: bool,
    consent_key_version: u64,
}
#[derive(Clone, Copy)]
pub(super) struct Operation {
    ticket: u64,
    generation: u64,
}

/// Exclusive native launch reservation. Dropping a failed/cancelled launch
/// revokes only its original consent generation, never a newer approval.
pub(super) struct RuntimeClaim {
    pub identity: std::sync::Arc<std::sync::Mutex<IdentityState>>,
    pub local: LocalConsent,
    pub generation: u64,
    transferred: bool,
}
impl RuntimeClaim {
    pub fn reserve(
        identity: std::sync::Arc<std::sync::Mutex<IdentityState>>,
        now: Instant,
    ) -> Result<Self, &'static str> {
        let (local, generation) = identity
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .claim_for_runtime(now)?;
        Ok(Self {
            identity,
            local,
            generation,
            transferred: false,
        })
    }
    pub fn check(&self, now: Instant) -> Result<(), &'static str> {
        if self
            .identity
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .runtime_is_current(self.generation, &self.local.session_id, now)
        {
            Ok(())
        } else {
            Err("REMOTE_OPERATION_CANCELLED")
        }
    }
    pub fn transfer(
        mut self,
        now: Instant,
    ) -> Result<
        (
            std::sync::Arc<std::sync::Mutex<IdentityState>>,
            LocalConsent,
            u64,
        ),
        &'static str,
    > {
        self.check(now)?;
        self.transferred = true;
        Ok((self.identity.clone(), self.local.clone(), self.generation))
    }
}
impl Drop for RuntimeClaim {
    fn drop(&mut self) {
        if !self.transferred {
            self.identity
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .end_runtime(self.generation, &self.local.session_id);
        }
    }
}
impl IdentityState {
    /// Rust supervisor only. No invoke accepts/returns a LocalConsent.
    pub(super) fn approved_for_runtime(
        &self,
        now: Instant,
    ) -> Result<(LocalConsent, u64), &'static str> {
        let consent = self
            .consent
            .as_ref()
            .filter(|consent| now < consent.deadline)
            .ok_or("REMOTE_LOCAL_CONSENT_REQUIRED")?;
        Ok((consent.clone(), self.generation))
    }
    pub(super) fn claim_for_runtime(
        &mut self,
        now: Instant,
    ) -> Result<(LocalConsent, u64), &'static str> {
        if self.runtime_claimed {
            return Err("REMOTE_LOCAL_SESSION_BUSY");
        }
        let result = self.approved_for_runtime(now)?;
        self.runtime_claimed = true;
        Ok(result)
    }
    pub(super) fn runtime_is_current(
        &self,
        generation: u64,
        session_id: &str,
        now: Instant,
    ) -> bool {
        self.generation == generation
            && self
                .consent
                .as_ref()
                .is_some_and(|consent| consent.session_id == session_id && now < consent.deadline)
    }
    pub(super) fn end_runtime(&mut self, generation: u64, session_id: &str) {
        if self.generation == generation
            && self
                .consent
                .as_ref()
                .is_some_and(|consent| consent.session_id == session_id)
        {
            self.stop();
        }
    }
    /// Only an authenticated native lease can synchronize the OS confirmation
    /// state to view-only. A webview pause/state boolean never creates consent.
    pub(super) fn observe_view_lease(
        &mut self,
        generation: u64,
        lease: &VerifiedLease,
        now: Instant,
    ) -> Result<(), &'static str> {
        if !self.runtime_is_current(generation, lease.session_id(), now) {
            return Err("REMOTE_OPERATION_CANCELLED");
        }
        let local = self.consent.as_mut().unwrap();
        if lease.scope() == Scope::View
            && lease.authorization_revision() >= local.authorization_revision
            && lease.control_epoch() >= local.control_epoch
        {
            local.scope = Scope::View;
            local.authorization_revision = lease.authorization_revision();
            local.control_epoch = lease.control_epoch();
        }
        Ok(())
    }
    pub fn begin(&mut self) -> Result<Operation, &'static str> {
        if self.pending.is_some() {
            return Err("REMOTE_OPERATION_BUSY");
        }
        self.next_ticket = self
            .next_ticket
            .checked_add(1)
            .ok_or("REMOTE_OPERATION_CANCELLED")?;
        self.pending = Some(self.next_ticket);
        Ok(Operation {
            ticket: self.next_ticket,
            generation: self.generation,
        })
    }
    pub fn check(&self, operation: Operation) -> Result<(), &'static str> {
        if self.pending == Some(operation.ticket) && self.generation == operation.generation {
            Ok(())
        } else {
            Err("REMOTE_OPERATION_CANCELLED")
        }
    }
    pub fn finish(&mut self, operation: Operation) -> Result<(), &'static str> {
        let result = self.check(operation);
        self.release(operation);
        result
    }
    pub fn release(&mut self, operation: Operation) {
        if self.pending == Some(operation.ticket) {
            self.pending = None;
        }
    }
    pub fn invalidate_for_reset(
        &mut self,
        operation: Operation,
    ) -> Result<Operation, &'static str> {
        self.check(operation)?;
        self.stop();
        Ok(Operation {
            generation: self.generation,
            ..operation
        })
    }
    pub fn stop(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.consent = None;
        self.runtime_claimed = false;
    }
    pub fn prepare(
        &mut self,
        operation: Operation,
        mut request: VerifiedApproval,
        now: Instant,
    ) -> Result<VerifiedApproval, &'static str> {
        self.check(operation)?;
        request.check_live(now)?;
        let claims = &request.claims;
        if claims.action == "grant-control" {
            let local = self
                .consent
                .as_ref()
                .ok_or("REMOTE_LOCAL_CONSENT_REQUIRED")?;
            if now >= local.deadline
                || local.scope != Scope::View
                || claims.requested_scope != Scope::Control
                || local.session_id != claims.session_id
                || local.host != claims.host
                || local.controller != claims.controller
                || local.screen_id != claims.screen_id
                || claims.authorization_revision <= local.authorization_revision
                || claims.control_epoch <= local.control_epoch
            {
                return Err("REMOTE_LOCAL_CONSENT_REQUIRED");
            }
            request.session_deadline = request.session_deadline.min(local.deadline);
            request.deadline = request.deadline.min(local.deadline);
        } else if self
            .consent
            .as_ref()
            .is_some_and(|local| now < local.deadline)
        {
            return Err("REMOTE_LOCAL_SESSION_BUSY");
        }
        self.used.retain(|_, deadline| now < *deadline);
        if self.used.contains_key(&claims.approval_id) {
            return Err("REMOTE_APPROVAL_REPLAY");
        }
        if self.used.len() >= 64 {
            return Err("REMOTE_APPROVAL_RATE_LIMITED");
        }
        self.used
            .insert(claims.approval_id.clone(), request.deadline);
        Ok(request)
    }
    pub fn approve_with_memory(
        &mut self, operation: Operation, request: VerifiedApproval,
        choice: super::consent_dialog::Choice, preferences: &mut super::consent_memory::Preferences,
        now_ms: u64, now: Instant,
    ) -> Result<(ConsentResponse, bool), &'static str> {
        let decision = if request.is_grant_control() && choice.decision != Decision::Control {
            Decision::Reject
        } else { choice.decision };
        let mut next = preferences.clone();
        let remember = request.remember_choice(&mut next, decision, choice.remember);
        let response = self.approve(operation, request, decision, now_ms, now)?;
        if remember { *preferences = next; }
        Ok((response, remember))
    }
    pub fn approve(
        &mut self,
        operation: Operation,
        request: VerifiedApproval,
        decision: Decision,
        now_ms: u64,
        now: Instant,
    ) -> Result<ConsentResponse, &'static str> {
        self.check(operation)?;
        let c = &request.claims;
        request.check_live(now)?;
        if now_ms < c.issued_at || now_ms >= c.expires_at {
            return Err("REMOTE_APPROVAL_EXPIRED");
        }
        if decision == Decision::Control && c.requested_scope != Scope::Control {
            return Err("INVALID_NATIVE_DECISION");
        }
        let mut nonce = [0u8; 32];
        getrandom::getrandom(&mut nonce).map_err(|_| "REMOTE_RANDOM_UNAVAILABLE")?;
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        // A declined grant-control preserves the current view authorization
        // exactly as the server coordinator does; never replace its nonce.
        let decision = if c.action == "grant-control" && decision != Decision::Control {
            Decision::Reject
        } else {
            decision
        };
        let choice = match decision {
            Decision::View => "view",
            Decision::Control => "control",
            Decision::Reject => "reject",
        };
        let body = serde_json::json!({ "protocolVersion":1, "purpose":"host-consent", "approvalId":c.approval_id,
            "action":c.action, "sessionId":c.session_id, "host":c.host, "controller":c.controller,
            "requestedScope":c.requested_scope, "decision":choice, "consentNonce":nonce, "screenId":c.screen_id,
            "authorizationRevision":c.authorization_revision, "controlEpoch":c.control_epoch, "issuedAt":now_ms, "expiresAt":c.expires_at });
        let payload = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&body).map_err(|_| "INVALID_NATIVE_DECISION")?);
        let key_id = format!("device:{}:{}", c.host.endpoint_id, c.host_key_version);
        let message = format!("{DOMAIN}\n{key_id}\n{payload}");
        let consent = SignedEnvelope {
            format: "rc-signed-v1".into(),
            key_id,
            payload,
            signature: URL_SAFE_NO_PAD.encode(request.key.sign(message.as_bytes()).to_bytes()),
        };
        if decision == Decision::Reject {
            if c.action == "accept" {
                self.consent = None;
            }
        } else {
            self.consent_key_version = c.host_key_version;
            self.consent = Some(LocalConsent {
                session_id: c.session_id.clone(),
                host: c.host.clone(),
                controller: c.controller.clone(),
                consent_nonce: nonce,
                screen_id: c.screen_id.clone(),
                scope: if decision == Decision::Control {
                    Scope::Control
                } else {
                    Scope::View
                },
                authorization_revision: c.authorization_revision,
                control_epoch: c.control_epoch,
                deadline: request.session_deadline,
            });
        }
        Ok(ConsentResponse { consent })
    }
}
/// Native-only evidence signing. The OS key and version come from this process's verified consent.
pub(super) fn sign_runtime_fact(
    state: &IdentityState,
    generation: u64,
    session_id: &str,
    body: serde_json::Value,
    now: Instant,
) -> Result<SignedEnvelope, &'static str> {
    if !state.runtime_is_current(generation, session_id, now)
        || !state.runtime_claimed
        || state.consent_key_version == 0
    {
        return Err("REMOTE_LOCAL_CONSENT_REQUIRED");
    }
    let host = &state
        .consent
        .as_ref()
        .ok_or("REMOTE_LOCAL_CONSENT_REQUIRED")?
        .host;
    sign_native_fact(
        &super::device_store::OsSeedStore,
        host,
        state.consent_key_version,
        body,
    )
}
pub(super) fn sign_native_fact(
    store: &impl SeedStore,
    host: &Endpoint,
    version: u64,
    body: serde_json::Value,
) -> Result<SignedEnvelope, &'static str> {
    let key = signing_key(store, host.user_id, false)?;
    let key_id = format!("device:{}:{}", host.endpoint_id, version);
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&body).map_err(|_| "INVALID_NATIVE_EVIDENCE")?);
    let signature = URL_SAFE_NO_PAD.encode(
        key.sign(format!("{DOMAIN}\n{key_id}\n{payload}").as_bytes())
            .to_bytes(),
    );
    Ok(SignedEnvelope {
        format: "rc-signed-v1".into(),
        key_id,
        payload,
        signature,
    })
}
impl VerifiedApproval {
    fn remembered_binding(&self) -> super::consent_memory::Binding {
        let c = &self.claims;
        super::consent_memory::Binding {
            host_user: c.host.user_id, host_device: c.host.endpoint_id.clone(),
            host_auth_version: c.host.auth_version.clone(), host_key_version: c.host_key_version,
            host_key_fingerprint: c.host_key_fingerprint.clone(), controller_user: c.controller.user_id,
            controller_auth_version: c.controller.auth_version.clone(), screen: c.screen_id.clone(),
        }
    }
    pub fn remembered_choice(&self, preferences: &super::consent_memory::Preferences) -> Option<Decision> {
        preferences.decision(&self.remembered_binding(), self.claims.requested_scope, &self.key.verifying_key())
    }
    pub fn remember_choice(&self, preferences: &mut super::consent_memory::Preferences, decision: Decision, checked: bool) -> bool {
        preferences.remember(self.remembered_binding(), decision, checked, &self.key)
    }
    pub fn is_grant_control(&self) -> bool {
        self.claims.action == "grant-control"
    }
    pub fn check_live(&self, now: Instant) -> Result<(), &'static str> {
        if now < self.received || now >= self.deadline || now >= self.session_deadline {
            Err("REMOTE_APPROVAL_EXPIRED")
        } else {
            Ok(())
        }
    }
    pub fn verify(
        store: &impl SeedStore,
        keys: &PinnedKeys,
        envelope: &SignedEnvelope,
        now_ms: u64,
        now: Instant,
    ) -> Result<VerifiedApproval, &'static str> {
        let (bytes, not_before, not_after) = keys
            .verify_payload(envelope, now_ms)
            .map_err(|_| "INVALID_APPROVAL_REQUEST")?;
        let claims: ApprovalRequest =
            serde_json::from_slice(&bytes).map_err(|_| "INVALID_APPROVAL_REQUEST")?;
        if claims.protocol_version != 1
            || claims.issuer != "todesk-remote-control"
            || claims.audience != "todesk-native-approval"
            || claims.purpose != "approval-request"
            || !uuid(&claims.approval_id)
            || !uuid(&claims.session_id)
            || !claims.host.valid()
            || !claims.controller.valid()
            || !positive(claims.authorization_revision)
            || !positive(claims.control_epoch)
            || !positive(claims.host_key_version)
            || claims.screen_id != "primary"
            || !["accept", "grant-control"].contains(&claims.action.as_str())
            || claims.host_key_fingerprint.len() != 64
            || !claims
                .host_key_fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("INVALID_APPROVAL_REQUEST");
        }
        if claims.issued_at > now_ms
            || claims.issued_at < not_before
            || claims.expires_at <= now_ms
            || claims.expires_at > not_after
            || claims.expires_at.saturating_sub(claims.issued_at) > 45_000
            || claims.session_expires_at < claims.expires_at
            || claims.session_expires_at > MAX_SAFE
            || claims.session_expires_at.saturating_sub(claims.issued_at) > 3_600_000
        {
            return Err("REMOTE_APPROVAL_EXPIRED");
        }
        let session_deadline = now + Duration::from_millis(claims.session_expires_at - now_ms);
        let key = signing_key(store, claims.host.user_id, false)?;
        if fingerprint(&key) != claims.host_key_fingerprint {
            return Err("REMOTE_DEVICE_KEY_MISMATCH");
        }
        let deadline = now + Duration::from_millis(claims.expires_at - now_ms);
        Ok(VerifiedApproval {
            claims,
            key,
            received: now,
            deadline,
            session_deadline,
        })
    }

    pub fn consent_prompt(&self) -> super::consent_dialog::Prompt {
        super::consent_dialog::Prompt {
            controller_account: self.claims.controller.user_id,
            details: self.message(),
            control: self.wants_control(),
            deadline: self.deadline,
        }
    }

    pub fn message(&self) -> String {
        let c = &self.claims;
        format!("请求方账号：{}\n请求方设备：{}\n本机账号：{}\n会话：{}\n共享范围：主显示器\n请求权限：{}\n\n仅在认识并信任对方时批准。此确认在 45 秒内过期。勾选“不再提示”并允许后，此账号在相同或更小权限范围内的后续请求将自动批准；可在本机协助设置中恢复每次确认。",
            c.controller.user_id, c.controller.endpoint_id, c.host.user_id, c.session_id,
            if c.requested_scope == Scope::Control { "查看屏幕和键鼠控制" } else { "仅查看屏幕" })
    }
    pub fn wants_control(&self) -> bool {
        self.claims.requested_scope == Scope::Control
    }
}

pub(super) fn identity_fingerprint(
    store: &impl SeedStore,
    user: u64,
) -> Result<String, &'static str> {
    if !positive(user) {
        return Err("INVALID_DEVICE_USER");
    }
    Ok(fingerprint(&signing_key(store, user, false)?))
}
pub(super) fn reset_identity(
    store: &impl SeedStore,
    user: u64,
    expected: &str,
) -> Result<(), &'static str> {
    if identity_fingerprint(store, user)? != expected {
        return Err("REMOTE_DEVICE_KEY_MISMATCH");
    }
    let mut seed = Zeroizing::new(vec![0u8; 32]);
    getrandom::getrandom(&mut seed).map_err(|_| "REMOTE_RANDOM_UNAVAILABLE")?;
    store.write(user, &seed)?;
    let saved = store.read(user)?.ok_or("REMOTE_KEYSTORE_UNAVAILABLE")?;
    if *saved != *seed {
        return Err("REMOTE_KEYSTORE_INVALID");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signature;
    use serde_json::Value;
    use std::{cell::RefCell, collections::HashMap};
    const FIXTURE: &str =
        include_str!("../../../../fixtures/remote-control-native-approval-v1.json");
    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<u64, Vec<u8>>>);
    impl SeedStore for MemoryStore {
        fn read(&self, user: u64) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
            Ok(self.0.borrow().get(&user).cloned().map(Zeroizing::new))
        }
        fn write(&self, user: u64, seed: &[u8]) -> Result<(), &'static str> {
            self.0.borrow_mut().insert(user, seed.to_vec());
            Ok(())
        }
    }
    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks(2)
            .map(|s| u8::from_str_radix(std::str::from_utf8(s).unwrap(), 16).unwrap())
            .collect()
    }
    fn fixture() -> (Value, MemoryStore, PinnedKeys, SignedEnvelope, u64, Instant) {
        let f: Value = serde_json::from_str(FIXTURE).unwrap();
        let store = MemoryStore::default();
        store
            .write(1, &hex(f["testDeviceSeedHex"].as_str().unwrap()))
            .unwrap();
        let keys =
            PinnedKeys::new(vec![serde_json::from_value(f["key"].clone()).unwrap()]).unwrap();
        let request = serde_json::from_value(f["approval"].clone()).unwrap();
        let ms = f["now"].as_u64().unwrap();
        (f, store, keys, request, ms, Instant::now())
    }
    fn changed(request: &SignedEnvelope, edit: impl FnOnce(&mut Value)) -> SignedEnvelope {
        let mut body: Value =
            serde_json::from_slice(&decode(&request.payload, None).unwrap()).unwrap();
        edit(&mut body);
        let seed: [u8; 32] =
            hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .try_into()
                .unwrap();
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&body).unwrap());
        let message = format!("{DOMAIN}\n{}\n{payload}", request.key_id);
        SignedEnvelope {
            payload,
            signature: URL_SAFE_NO_PAD.encode(
                SigningKey::from_bytes(&seed)
                    .sign(message.as_bytes())
                    .to_bytes(),
            ),
            ..request.clone()
        }
    }
    fn prepare(
        state: &mut IdentityState,
        op: Operation,
        store: &MemoryStore,
        keys: &PinnedKeys,
        token: &SignedEnvelope,
        ms: u64,
        now: Instant,
    ) -> Result<VerifiedApproval, &'static str> {
        state.prepare(
            op,
            VerifiedApproval::verify(store, keys, token, ms, now)?,
            now,
        )
    }
    #[test]
    fn registration_is_exactly_the_node_canonical_signature() {
        let (f, store, _, _, ms, _) = fixture();
        let challenge = serde_json::from_value(f["registrationChallenge"].clone()).unwrap();
        let proof = register(&store, challenge, "本机 Mac".into(), ms).unwrap();
        assert_eq!(
            proof.public_key,
            f["registration"]["publicKey"].as_str().unwrap()
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            proof.signature,
            f["registration"]["signature"].as_str().unwrap()
        );
        assert_eq!(
            fingerprint(&signing_key(&store, 1, false).unwrap()),
            f["device"]["fingerprint"].as_str().unwrap()
        );
    }
    #[test]
    fn generated_identity_persists_and_is_account_scoped() {
        let store = MemoryStore::default();
        let first = signing_key(&store, 1, true).unwrap();
        assert_eq!(
            first.verifying_key(),
            signing_key(&store, 1, true).unwrap().verifying_key()
        );
        assert_ne!(
            first.verifying_key(),
            signing_key(&store, 2, true).unwrap().verifying_key()
        );
        store.write(3, &[0; 31]).unwrap();
        assert_eq!(
            signing_key(&store, 3, true).err(),
            Some("REMOTE_KEYSTORE_INVALID")
        );
        assert_eq!(store.read(3).unwrap().unwrap().len(), 31);
        assert_eq!(
            signing_key(&store, 4, false).err(),
            Some("REMOTE_DEVICE_NOT_REGISTERED")
        );
    }
    #[test]
    fn registration_never_signs_other_actions_expired_challenges_or_control_characters() {
        let (f, store, _, _, ms, _) = fixture();
        for mode in 0..5 {
            let mut challenge: DeviceChallenge =
                serde_json::from_value(f["registrationChallenge"].clone()).unwrap();
            let alias = match mode {
                0 => "line\nbreak",
                _ => "Local device",
            };
            match mode {
                1 => challenge.action = "host-consent".into(),
                2 => challenge.expires_at = ms,
                3 => challenge.expires_at = ms + 30_001,
                4 => challenge.user_id = 0,
                _ => (),
            }
            assert!(register(&store, challenge, alias.into(), ms).is_err());
        }
    }
    #[test]
    fn approval_and_host_consent_interoperate_with_node_fixture() {
        let (f, store, keys, token, ms, now) = fixture();
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        assert!(request.message().contains("请求方账号：2"));
        let response = state
            .approve(op, request, Decision::Control, ms, now)
            .unwrap();
        let claims: Value =
            serde_json::from_slice(&decode(&response.consent.payload, None).unwrap()).unwrap();
        let mut expected = f["consentClaims"].clone();
        expected["consentNonce"] = claims["consentNonce"].clone();
        assert_eq!(claims, expected);
        assert_ne!(claims["consentNonce"], f["consentClaims"]["consentNonce"]);
        assert_eq!(
            decode(claims["consentNonce"].as_str().unwrap(), Some(32))
                .unwrap()
                .len(),
            32
        );
        let key = signing_key(&store, 1, false).unwrap();
        for envelope in [
            response.consent,
            serde_json::from_value(f["consent"].clone()).unwrap(),
        ] {
            let sig: [u8; 64] = decode(&envelope.signature, Some(64))
                .unwrap()
                .try_into()
                .unwrap();
            key.verifying_key()
                .verify_strict(
                    format!("{DOMAIN}\n{}\n{}", envelope.key_id, envelope.payload).as_bytes(),
                    &Signature::from_bytes(&sig),
                )
                .unwrap();
        }
        assert_eq!(state.consent.as_ref().unwrap().scope, Scope::Control);
        state.finish(op).unwrap();
        state.stop();
        assert!(state.consent.is_none());
    }
    #[test]
    fn wrong_trust_device_context_and_signed_schema_are_rejected() {
        let (_, store, keys, token, ms, now) = fixture();
        for field in [
            "purpose",
            "audience",
            "hostKeyFingerprint",
            "screenId",
            "unknown",
        ] {
            let token = changed(&token, |c| c[field] = "wrong".into());
            assert!(VerifiedApproval::verify(&store, &keys, &token, ms, now).is_err());
        }
        for token in [
            changed(&token, |c| c["host"]["userId"] = 2.into()),
            changed(&token, |c| c["host"]["generation"] = 0.into()),
            changed(&token, |c| c["expiresAt"] = (ms + 45_001).into()),
            changed(&token, |c| c["sessionExpiresAt"] = (ms + 3_600_001).into()),
        ] {
            assert!(VerifiedApproval::verify(&store, &keys, &token, ms, now).is_err());
        }
        let mut unknown = token.clone();
        unknown.key_id = "browser-supplied".into();
        assert!(VerifiedApproval::verify(&store, &keys, &unknown, ms, now).is_err());
        let mut tampered = token;
        tampered.signature = URL_SAFE_NO_PAD.encode([0; 64]);
        assert!(VerifiedApproval::verify(&store, &keys, &tampered, ms, now).is_err());
    }
    #[test]
    fn remembered_choices_commit_only_after_valid_live_approval() {
        use super::super::{consent_dialog::Choice, consent_memory::Preferences};
        for expired in [false, true] {
            let (_, store, keys, token, ms, now) = fixture();
            let mut state = IdentityState::default();
            let op = state.begin().unwrap();
            let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
            let binding = request.remembered_binding();
            let key = request.key.verifying_key();
            let mut prefs = Preferences::default();
            let end = if expired { now + Duration::from_secs(46) } else { state.stop(); now };
            assert!(state.approve_with_memory(op, request, Choice { decision: Decision::Control, remember: true }, &mut prefs, ms, end).is_err());
            assert_eq!(prefs.decision(&binding, Scope::Control, &key), None);
        }
        let (_, store, keys, token, ms, now) = fixture();
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        let mut prefs = Preferences::default();
        let (_, saved) = state.approve_with_memory(op, request, Choice { decision: Decision::View, remember: true }, &mut prefs, ms, now).unwrap();
        assert!(saved);
        state.finish(op).unwrap(); state.stop();
        // A new session still verifies a fresh server proof and creates fresh local consent.
        let next_token = changed(&token, |c| {
            c["approvalId"] = "99999999-9999-4999-8999-999999999999".into();
            c["sessionId"] = "88888888-8888-4888-8888-888888888888".into();
            c["requestedScope"] = "view".into();
        });
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &next_token, ms, now).unwrap();
        assert_eq!(request.remembered_choice(&prefs), Some(Decision::View));
        state.approve_with_memory(op, request, Choice { decision: Decision::View, remember: false }, &mut prefs, ms, now).unwrap();
        assert_eq!(state.consent.as_ref().unwrap().session_id, "88888888-8888-4888-8888-888888888888");
    }
    #[test]
    fn stop_while_keychain_or_dialog_is_waiting_invalidates_late_results() {
        let (_, store, keys, token, ms, now) = fixture();
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        state.stop();
        assert_eq!(
            state.approve(op, request, Decision::Control, ms, now).err(),
            Some("REMOTE_OPERATION_CANCELLED")
        );
        assert!(state.consent.is_none());
        assert_eq!(state.finish(op), Err("REMOTE_OPERATION_CANCELLED"));
        let next = state.begin().unwrap();
        state.stop();
        assert_eq!(state.check(next), Err("REMOTE_OPERATION_CANCELLED"));
    }
    #[test]
    fn expired_dialog_cannot_be_approved_even_after_wall_clock_rollback() {
        let (_, store, keys, token, ms, now) = fixture();
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        assert_eq!(
            state
                .approve(
                    op,
                    request,
                    Decision::View,
                    ms,
                    now + Duration::from_secs(45)
                )
                .err(),
            Some("REMOTE_APPROVAL_EXPIRED")
        );
        assert!(state.consent.is_none());
        state.finish(op).unwrap();
        let op = state.begin().unwrap();
        let request = VerifiedApproval::verify(&store, &keys, &token, ms, now).unwrap();
        // Keychain work and the first dialog may finish after request expiry.
        assert_eq!(
            request.check_live(now + Duration::from_secs(45)),
            Err("REMOTE_APPROVAL_EXPIRED")
        );
        assert_eq!(
            state
                .prepare(op, request, now + Duration::from_secs(45))
                .err(),
            Some("REMOTE_APPROVAL_EXPIRED")
        );
    }
    #[test]
    fn denied_approval_cannot_be_replayed_or_prompts_stacked() {
        let (_, store, keys, token, ms, now) = fixture();
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        assert_eq!(state.begin().err(), Some("REMOTE_OPERATION_BUSY"));
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        state
            .approve(op, request, Decision::Reject, ms, now)
            .unwrap();
        state.finish(op).unwrap();
        let op = state.begin().unwrap();
        assert_eq!(
            prepare(&mut state, op, &store, &keys, &token, ms, now).err(),
            Some("REMOTE_APPROVAL_REPLAY")
        );
    }
    #[test]
    fn view_request_cannot_yield_a_control_decision() {
        let (_, store, keys, token, ms, now) = fixture();
        let token = changed(&token, |c| c["requestedScope"] = "view".into());
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        assert_eq!(
            state.approve(op, request, Decision::Control, ms, now).err(),
            Some("INVALID_NATIVE_DECISION")
        );
    }
    #[test]
    fn grant_control_requires_live_view_consent_and_rejection_preserves_it() {
        let (_, store, keys, token, ms, now) = fixture();
        let grant = changed(&token, |c| {
            c["approvalId"] = "99999999-9999-4999-8999-999999999999".into();
            c["action"] = "grant-control".into();
            c["authorizationRevision"] = 2.into();
            c["controlEpoch"] = 2.into();
        });
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        assert_eq!(
            prepare(&mut state, op, &store, &keys, &grant, ms, now).err(),
            Some("REMOTE_LOCAL_CONSENT_REQUIRED")
        );
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        state.approve(op, request, Decision::View, ms, now).unwrap();
        state.finish(op).unwrap();
        let old_nonce = state.consent.as_ref().unwrap().consent_nonce.clone();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &grant, ms, now).unwrap();
        state.approve(op, request, Decision::View, ms, now).unwrap();
        state.finish(op).unwrap();
        assert_eq!(state.consent.as_ref().unwrap().scope, Scope::View);
        assert_eq!(state.consent.as_ref().unwrap().consent_nonce, old_nonce);
        let grant = changed(&grant, |c| {
            c["approvalId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()
        });
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &grant, ms, now).unwrap();
        state
            .approve(op, request, Decision::Control, ms, now)
            .unwrap();
        assert_ne!(state.consent.as_ref().unwrap().consent_nonce, old_nonce);
        assert_eq!(state.consent.as_ref().unwrap().scope, Scope::Control);
        state.finish(op).unwrap();
        state.stop();
        let op = state.begin().unwrap();
        assert_eq!(
            prepare(&mut state, op, &store, &keys, &grant, ms, now).err(),
            Some("REMOTE_LOCAL_CONSENT_REQUIRED")
        );
    }
    #[test]
    fn explicit_rebuild_rotates_only_the_selected_existing_account() {
        let (_, store, _, _, _, _) = fixture();
        let before = identity_fingerprint(&store, 1).unwrap();
        let second = signing_key(&store, 2, true).unwrap().verifying_key();
        assert_eq!(
            reset_identity(&store, 1, "wrong"),
            Err("REMOTE_DEVICE_KEY_MISMATCH")
        );
        assert_eq!(
            reset_identity(&store, 3, &before),
            Err("REMOTE_DEVICE_NOT_REGISTERED")
        );
        reset_identity(&store, 1, &before).unwrap();
        assert_ne!(identity_fingerprint(&store, 1).unwrap(), before);
        assert_eq!(
            signing_key(&store, 2, false).unwrap().verifying_key(),
            second
        );
    }
    #[test]
    fn failed_read_after_rotation_does_not_restore_old_local_authority() {
        use std::cell::Cell;
        let (_, store, keys, token, ms, now) = fixture();
        let mut state = IdentityState::default();
        let op = state.begin().unwrap();
        let request = prepare(&mut state, op, &store, &keys, &token, ms, now).unwrap();
        state.approve(op, request, Decision::View, ms, now).unwrap();
        state.finish(op).unwrap();
        let old = identity_fingerprint(&store, 1).unwrap();
        struct PartialWrite {
            inner: MemoryStore,
            wrote: Cell<bool>,
        }
        impl SeedStore for PartialWrite {
            fn read(&self, user: u64) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
                if self.wrote.get() {
                    Err("REMOTE_KEYSTORE_UNAVAILABLE")
                } else {
                    self.inner.read(user)
                }
            }
            fn write(&self, user: u64, seed: &[u8]) -> Result<(), &'static str> {
                self.inner.write(user, seed)?;
                self.wrote.set(true);
                Ok(())
            }
        }
        let partial = PartialWrite {
            inner: store,
            wrote: Cell::new(false),
        };
        let original = state.begin().unwrap();
        // The native command performs this before calling the OS store.
        let reset = state.invalidate_for_reset(original).unwrap();
        assert_eq!(state.check(original), Err("REMOTE_OPERATION_CANCELLED"));
        assert!(state.consent.is_none());
        assert_eq!(
            reset_identity(&partial, 1, &old),
            Err("REMOTE_KEYSTORE_UNAVAILABLE")
        );
        assert!(partial.wrote.get());
        assert_ne!(identity_fingerprint(&partial.inner, 1).unwrap(), old);
        assert!(state.consent.is_none());
        state.release(original);
        assert_eq!(state.check(reset), Err("REMOTE_OPERATION_CANCELLED"));
        assert!(state.begin().is_ok());
    }
}

/// Explicit development binary only. Uses a public RFC test seed, verifies a
/// real server-signed approval and runs the same LocalConsent state transition.
/// It is absent from normal builds and is never callable through invoke.
#[cfg(any(test, feature = "remote-control-harness"))]
pub(super) fn approve_harness_fixture(
    keys: &PinnedKeys,
    envelope: &SignedEnvelope,
    decision: Decision,
    now_ms: u64,
    now: Instant,
) -> Result<(IdentityState, ConsentResponse), &'static str> {
    struct FixtureStore;
    impl SeedStore for FixtureStore {
        fn read(&self, user: u64) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
            if user != 1 {
                return Ok(None);
            }
            let hex = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
            Ok(Some(Zeroizing::new(
                hex.as_bytes()
                    .chunks(2)
                    .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
                    .collect(),
            )))
        }
        fn write(&self, _: u64, _: &[u8]) -> Result<(), &'static str> {
            Err("HARNESS_READ_ONLY_KEY")
        }
    }
    let mut state = IdentityState::default();
    let operation = state.begin()?;
    let request = VerifiedApproval::verify(&FixtureStore, keys, envelope, now_ms, now)?;
    let request = state.prepare(operation, request, now)?;
    let response = state.approve(operation, request, decision, now_ms, now)?;
    state.finish(operation)?;
    Ok((state, response))
}
