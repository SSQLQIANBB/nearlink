//! Device liveness only. This proof cannot create consent, start media or inject input.
use super::{
    authorization::{decode, positive, Endpoint, PinnedKeys, SignedEnvelope},
    device_store::SeedStore,
    identity,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    protocol_version: u32,
    issuer: String,
    audience: String,
    purpose: String,
    host: Endpoint,
    challenge: String,
    host_key_version: u64,
    host_key_fingerprint: String,
    issued_at: u64,
    expires_at: u64,
}
pub(super) fn prove(
    store: &impl SeedStore,
    keys: &PinnedKeys,
    envelope: &SignedEnvelope,
    engine_digest: String,
    capture: bool,
    input: bool,
    now: u64,
) -> Result<SignedEnvelope, &'static str> {
    let (bytes, before, after) = keys
        .verify_payload(envelope, now)
        .map_err(|_| "INVALID_PRESENCE_CHALLENGE")?;
    let c: Challenge = serde_json::from_slice(&bytes).map_err(|_| "INVALID_PRESENCE_CHALLENGE")?;
    if c.protocol_version != 1
        || c.issuer != "todesk-remote-control"
        || c.audience != "todesk-native-presence"
        || c.purpose != "presence-challenge"
        || !c.host.valid()
        || !positive(c.host_key_version)
        || decode(&c.challenge, Some(32)).is_err()
        || c.issued_at > now
        || c.issued_at < before
        || c.expires_at <= now
        || c.expires_at > after
        || c.expires_at.saturating_sub(c.issued_at) > 30_000
        || engine_digest.len() != 64
        || !engine_digest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("INVALID_PRESENCE_CHALLENGE");
    }
    if identity::identity_fingerprint(store, c.host.user_id)? != c.host_key_fingerprint {
        return Err("REMOTE_DEVICE_KEY_MISMATCH");
    }
    identity::sign_native_fact(
        store,
        &c.host,
        c.host_key_version,
        json!({
            "protocolVersion":1, "purpose":"native-presence", "host":c.host, "challenge":c.challenge,
            "platform":"macos", "engineDigest":engine_digest, "canCapture":capture, "canControl":capture && input,
            "issuedAt":now, "expiresAt":c.expires_at
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::Value;
    use zeroize::Zeroizing;
    struct Store(Vec<u8>);
    impl SeedStore for Store {
        fn read(&self, _: u64) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
            Ok(Some(Zeroizing::new(self.0.clone())))
        }
        fn write(&self, _: u64, _: &[u8]) -> Result<(), &'static str> {
            panic!("presence must never create a key")
        }
    }
    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks(2)
            .map(|s| u8::from_str_radix(std::str::from_utf8(s).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn presence_is_bound_to_signed_server_challenge_and_device_key_without_creating_consent() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/remote-control-native-approval-v1.json"
        ))
        .unwrap();
        let ms = fixture["now"].as_u64().unwrap();
        let store = Store(hex(fixture["testDeviceSeedHex"].as_str().unwrap()));
        let keys =
            PinnedKeys::new(vec![serde_json::from_value(fixture["key"].clone()).unwrap()]).unwrap();
        let approval: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(fixture["approval"]["payload"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let body = json!({ "protocolVersion":1, "issuer":"todesk-remote-control", "audience":"todesk-native-presence", "purpose":"presence-challenge",
            "host":approval["host"], "hostKeyVersion":approval["hostKeyVersion"], "hostKeyFingerprint":approval["hostKeyFingerprint"],
            "challenge":URL_SAFE_NO_PAD.encode([7;32]), "issuedAt":ms, "expiresAt":ms+30000 });
        let seed: [u8; 32] =
            hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .try_into()
                .unwrap();
        let key = SigningKey::from_bytes(&seed);
        let sign = |body: &Value| {
            let key_id = fixture["key"]["keyId"].as_str().unwrap().to_string();
            let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(body).unwrap());
            let signature = URL_SAFE_NO_PAD.encode(
                key.sign(
                    format!(
                        "{}\n{key_id}\n{payload}",
                        super::super::authorization::DOMAIN
                    )
                    .as_bytes(),
                )
                .to_bytes(),
            );
            SignedEnvelope {
                format: "rc-signed-v1".into(),
                key_id,
                payload,
                signature,
            }
        };
        let proof = prove(
            &store,
            &keys,
            &sign(&body),
            "ab".repeat(32),
            false,
            true,
            ms,
        )
        .unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(proof.payload).unwrap()).unwrap();
        assert_eq!(claims["purpose"], "native-presence");
        assert_eq!(claims["canControl"], false);
        assert_eq!(claims["canCapture"], false);
        assert_eq!(claims["host"], body["host"]);
        assert_eq!(claims["challenge"], body["challenge"]);
        for (field, value) in [
            ("purpose", json!("approval-request")),
            ("audience", json!("todesk-native-approval")),
            ("hostKeyFingerprint", json!("ff".repeat(32))),
            ("expiresAt", json!(ms)),
            ("unexpected", json!(true)),
        ] {
            let mut changed = body.clone();
            changed[field] = value;
            assert!(prove(
                &store,
                &keys,
                &sign(&changed),
                "ab".repeat(32),
                true,
                true,
                ms
            )
            .is_err());
        }
        assert!(prove(
            &Store(vec![8; 32]),
            &keys,
            &sign(&body),
            "ab".repeat(32),
            true,
            true,
            ms
        )
        .is_err());
        assert!(prove(
            &store,
            &keys,
            &sign(&body),
            "ab".repeat(32),
            true,
            true,
            ms + 30000
        )
        .is_err());
    }
}
