//! A clock scoped to one authenticated server proof. It never reads the OS date.
//! It supplies timestamps, not authority: the typed verifier, local consent,
//! connection binding and one-use challenges must still accept every proof.
use super::authorization::{PinnedKeys, SignedEnvelope};
use serde::Deserialize;
use std::time::Instant;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
pub(super) struct ServerClock {
    issued: u64,
    received: Instant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Times {
    protocol_version: u32,
    issuer: String,
    issued_at: u64,
    expires_at: u64,
}

impl ServerClock {
    pub fn from_proof(
        keys: &PinnedKeys,
        proof: &SignedEnvelope,
        received: Instant,
    ) -> Result<Self, &'static str> {
        let (bytes, before, after) = keys
            .verify_signature(proof)
            .map_err(|_| "REMOTE_PROOF_INVALID")?;
        let times: Times = serde_json::from_slice(&bytes).map_err(|_| "REMOTE_PROOF_INVALID")?;
        if times.protocol_version != 1
            || times.issuer != "todesk-remote-control"
            || times.issued_at < before
            || times.expires_at > after
            || times.expires_at <= times.issued_at
        {
            return Err("REMOTE_PROOF_INVALID");
        }
        Ok(Self {
            issued: times.issued_at,
            received,
        })
    }

    pub fn now(&self, now: Instant) -> Result<u64, &'static str> {
        let elapsed = now
            .checked_duration_since(self.received)
            .ok_or("REMOTE_CLOCK_INVALID")?;
        self.issued
            .checked_add(u64::try_from(elapsed.as_millis()).map_err(|_| "REMOTE_CLOCK_INVALID")?)
            .filter(|value| *value <= MAX_SAFE)
            .ok_or("REMOTE_CLOCK_INVALID")
    }

    /// Call only after the session has accepted the new proof. Old timestamps
    /// never rewind the clock; local consent/lease deadlines are never changed.
    pub fn advance(&mut self, accepted: Self, now: Instant) -> Result<(), &'static str> {
        self.issued = self.now(now)?.max(accepted.now(now)?);
        self.received = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;

    #[test]
    fn signed_time_advances_only_with_elapsed_time_and_never_rewinds() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/remote-control-native-approval-v1.json"
        ))
        .unwrap();
        let keys =
            PinnedKeys::new(vec![serde_json::from_value(fixture["key"].clone()).unwrap()]).unwrap();
        let proof: SignedEnvelope = serde_json::from_value(fixture["approval"].clone()).unwrap();
        let received = Instant::now();
        let issued = fixture["approvalClaims"]["issuedAt"].as_u64().unwrap();
        let mut clock = ServerClock::from_proof(&keys, &proof, received).unwrap();
        assert_eq!(clock.now(received).unwrap(), issued);
        let later = received + Duration::from_secs(60);
        assert_eq!(clock.now(later).unwrap(), issued + 60_000);
        clock
            .advance(
                ServerClock::from_proof(&keys, &proof, later).unwrap(),
                later,
            )
            .unwrap();
        assert_eq!(clock.now(later).unwrap(), issued + 60_000);
        let mut tampered = proof;
        tampered.signature = "A".repeat(86);
        assert!(ServerClock::from_proof(&keys, &tampered, received).is_err());
    }
}
