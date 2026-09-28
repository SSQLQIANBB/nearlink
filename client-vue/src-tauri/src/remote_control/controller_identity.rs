//! Connection identity only: this proof cannot authorize capture, input or remembered consent.
use super::{authorization::{decode, positive, uuid, Endpoint, PinnedKeys, SignedEnvelope}, device_store::SeedStore, identity};
use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedController { controller: Endpoint, device_id: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    protocol_version: u32, issuer: String, audience: String, purpose: String,
    controller: Endpoint, device_id: String, key_version: u64, key_fingerprint: String,
    challenge: String, issued_at: u64, expires_at: u64,
}
pub(super) fn prove(store: &impl SeedStore, keys: &PinnedKeys, envelope: &SignedEnvelope,
    expected: ExpectedController, now: u64) -> Result<SignedEnvelope, &'static str> {
    let started = Instant::now();
    let (bytes, before, after) = keys.verify_payload(envelope, now).map_err(|_| "INVALID_CONTROLLER_CHALLENGE")?;
    let c: Challenge = serde_json::from_slice(&bytes).map_err(|_| "INVALID_CONTROLLER_CHALLENGE")?;
    if c.protocol_version != 1 || c.issuer != "todesk-remote-control" || c.audience != "todesk-native-controller"
        || c.purpose != "controller-challenge" || !c.controller.valid() || !uuid(&c.device_id) || !positive(c.key_version)
        || c.controller != expected.controller || c.device_id != expected.device_id || decode(&c.challenge, Some(32)).is_err()
        || c.issued_at > now || c.issued_at < before || c.expires_at <= now || c.expires_at > after
        || c.expires_at.saturating_sub(c.issued_at) > 30_000 {
        return Err("INVALID_CONTROLLER_CHALLENGE");
    }
    if identity::identity_fingerprint(store, c.controller.user_id)? != c.key_fingerprint { return Err("REMOTE_DEVICE_KEY_MISMATCH"); }
    let mut signer = c.controller.clone(); signer.endpoint_id = c.device_id.clone();
    let result = identity::sign_native_fact(store, &signer, c.key_version, json!({
        "protocolVersion":1, "purpose":"native-controller-binding", "controller":c.controller,
        "deviceId":c.device_id, "challenge":c.challenge, "issuedAt":now, "expiresAt":c.expires_at
    }))?;
    if started.elapsed() >= Duration::from_millis(c.expires_at - now) { return Err("INVALID_CONTROLLER_CHALLENGE"); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use zeroize::Zeroizing;
    struct Store(Vec<u8>);
    impl SeedStore for Store {
        fn read(&self, _: u64) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> { Ok(Some(Zeroizing::new(self.0.clone()))) }
        fn write(&self, _: u64, _: &[u8]) -> Result<(), &'static str> { panic!("binding must not create an identity") }
    }
    fn data() -> (Value, Store, PinnedKeys) {
        let v: Value = serde_json::from_str(include_str!("../../../../fixtures/remote-controller-binding-v1.json")).unwrap();
        let identity: Value = serde_json::from_str(include_str!("../../../../fixtures/remote-control-native-approval-v1.json")).unwrap();
        let bytes = identity["testDeviceSeedHex"].as_str().unwrap().as_bytes().chunks(2)
            .map(|s| u8::from_str_radix(std::str::from_utf8(s).unwrap(), 16).unwrap()).collect();
        let keys = PinnedKeys::new(vec![serde_json::from_value(v["key"].clone()).unwrap()]).unwrap();
        (v, Store(bytes), keys)
    }
    #[test]
    fn signed_controller_proof_matches_node_fixture() {
        let (v, store, keys) = data();
        let proof = prove(&store, &keys, &serde_json::from_value(v["challenge"].clone()).unwrap(),
            serde_json::from_value(v["expected"].clone()).unwrap(), v["now"].as_u64().unwrap()).unwrap();
        assert_eq!(proof.payload, v["proof"]["payload"]);
        assert_eq!(proof.signature, v["proof"]["signature"]);
        assert_eq!(proof.key_id, v["proof"]["keyId"]);
    }
    #[test]
    fn refuses_substituted_socket_device_key_expiry_and_other_signed_purpose() {
        let (v, store, keys) = data();
        let ms = v["now"].as_u64().unwrap();
        let envelope: SignedEnvelope = serde_json::from_value(v["challenge"].clone()).unwrap();
        for (field, value) in [("connectionId", json!("other")), ("sid", json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")), ("generation", json!(3))] {
            let mut expected = v["expected"].clone(); expected["controller"][field] = value;
            assert!(prove(&store, &keys, &envelope, serde_json::from_value(expected).unwrap(), ms).is_err());
        }
        let mut expected = v["expected"].clone(); expected["deviceId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert!(prove(&store, &keys, &envelope, serde_json::from_value(expected).unwrap(), ms).is_err());
        assert!(prove(&Store(vec![8;32]), &keys, &envelope, serde_json::from_value(v["expected"].clone()).unwrap(), ms).is_err());
        assert!(prove(&store, &keys, &envelope, serde_json::from_value(v["expected"].clone()).unwrap(), ms+30000).is_err());
        let other: Value = serde_json::from_str(include_str!("../../../../fixtures/remote-control-native-approval-v1.json")).unwrap();
        assert!(prove(&store, &keys, &serde_json::from_value(other["approval"].clone()).unwrap(), serde_json::from_value(v["expected"].clone()).unwrap(), ms).is_err());
        let mut tampered = envelope; tampered.payload.push('A');
        assert!(prove(&store, &keys, &tampered, serde_json::from_value(v["expected"].clone()).unwrap(), ms).is_err());
    }
}
