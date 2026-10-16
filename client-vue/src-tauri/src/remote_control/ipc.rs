//! Authenticated, bounded control frames on inherited process pipes. No media
//! bytes, credentials in argv/environment, or unauthenticated local sockets.
#![allow(dead_code)]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::time::Instant;
use zeroize::Zeroizing;

pub const MAX_LINE_BYTES: usize = 131_072;
pub const MAX_BODY_BYTES: usize = 98_000;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const DOMAIN: &str = "todesk-host-ipc/v1\n";
type HmacSha256 = Hmac<Sha256>;

pub struct IpcSession {
    session_id: String,
    launch_id: String,
    key: Zeroizing<[u8; 32]>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    protocol_version: u8,
    session_id: String,
    launch_id: String,
    key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    payload: String,
    mac: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Body {
    session_id: String,
    launch_id: String,
    seq: u64,
    kind: String,
    #[serde(deserialize_with = "strict_json")]
    payload: Value,
}

// serde_json::Value normally overwrites duplicate object fields. Preserve the
// Python peer's recursive rejection rule before command-specific decoding.
pub(super) fn strict_json<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Value, D::Error> {
    struct Strict(Value);
    impl<'de> Deserialize<'de> for Strict {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            strict_json(d).map(Strict)
        }
    }
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Value;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON without duplicate fields")
        }
        fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Value, E> {
            Ok(Value::Bool(v))
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Value, E> {
            Ok(v.into())
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Value, E> {
            Ok(v.into())
        }
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Value, E> {
            serde_json::Number::from_f64(v)
                .map(Value::Number)
                .ok_or_else(|| E::custom("Invalid number"))
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Value, E> {
            Ok(v.into())
        }
        fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Value, E> {
            Ok(Value::String(v))
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
            let mut values = Vec::new();
            while let Some(Strict(value)) = seq.next_element()? {
                values.push(value);
            }
            Ok(Value::Array(values))
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
            let mut values = serde_json::Map::new();
            while let Some(key) = map.next_key::<String>()? {
                if values.contains_key(&key) {
                    return Err(serde::de::Error::custom("Duplicate JSON field"));
                }
                let Strict(value) = map.next_value()?;
                values.insert(key, value);
            }
            Ok(Value::Object(values))
        }
    }
    deserializer.deserialize_any(Visitor)
}

#[derive(Debug)]
pub struct IpcMessage {
    pub kind: String,
    pub payload: Value,
    /// Local monotonic receipt time, never supplied by the child or serialized.
    pub received_at: Instant,
}

pub struct IpcCodec {
    session: IpcSession,
    send_direction: &'static str,
    recv_direction: &'static str,
    send_seq: u64,
    recv_seq: u64,
    failed: bool,
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn kind(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn decode64(value: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "Invalid IPC base64url")?;
    if URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err("Noncanonical IPC base64url".into());
    }
    Ok(bytes)
}
fn line(bytes: &[u8], max: usize) -> Result<&[u8], String> {
    if bytes.len() > max
        || bytes.last() != Some(&b'\n')
        || bytes[..bytes.len() - 1].contains(&b'\n')
    {
        return Err("Invalid IPC line".into());
    }
    Ok(&bytes[..bytes.len() - 1])
}

impl IpcSession {
    pub fn new(session_id: &str) -> Result<Self, String> {
        if !uuid(session_id) {
            return Err("Invalid IPC session".into());
        }
        let mut key = Zeroizing::new([0u8; 32]);
        let mut launch = [0u8; 32];
        getrandom::getrandom(&mut *key).map_err(|_| "IPC randomness unavailable")?;
        getrandom::getrandom(&mut launch).map_err(|_| "IPC randomness unavailable")?;
        Ok(Self {
            session_id: session_id.into(),
            launch_id: URL_SAFE_NO_PAD.encode(launch),
            key,
        })
    }
    pub fn bootstrap_line(&self) -> Result<Vec<u8>, String> {
        let bootstrap = Bootstrap {
            protocol_version: 1,
            session_id: self.session_id.clone(),
            launch_id: self.launch_id.clone(),
            key: URL_SAFE_NO_PAD.encode(*self.key),
        };
        let mut bytes = serde_json::to_vec(&bootstrap).map_err(|_| "Invalid IPC bootstrap")?;
        bytes.push(b'\n');
        Ok(bytes)
    }
    /// Consumes the launch secret so a second writer cannot reuse its sequence.
    pub fn supervisor_codec(self) -> IpcCodec {
        IpcCodec::new(self, false)
    }
}

impl IpcCodec {
    fn new(session: IpcSession, engine: bool) -> Self {
        let (send_direction, recv_direction) = if engine {
            ("engine-to-supervisor", "supervisor-to-engine")
        } else {
            ("supervisor-to-engine", "engine-to-supervisor")
        };
        Self {
            session,
            send_direction,
            recv_direction,
            send_seq: 0,
            recv_seq: 0,
            failed: false,
        }
    }
    pub fn encode(&mut self, message_kind: &str, payload: Value) -> Result<Vec<u8>, String> {
        let result = self.encode_inner(message_kind, payload);
        if result.is_err() {
            self.close();
        }
        result
    }
    fn encode_inner(&mut self, message_kind: &str, payload: Value) -> Result<Vec<u8>, String> {
        if self.failed || self.send_seq >= MAX_SEQUENCE {
            return Err("IPC closed".into());
        }
        if !kind(message_kind) || !payload.is_object() {
            return Err("Invalid IPC message".into());
        }
        let body = Body {
            session_id: self.session.session_id.clone(),
            launch_id: self.session.launch_id.clone(),
            seq: self.send_seq + 1,
            kind: message_kind.into(),
            payload,
        };
        let bytes = serde_json::to_vec(&body).map_err(|_| "Invalid IPC JSON")?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err("IPC body too large".into());
        }
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        let mut signer =
            HmacSha256::new_from_slice(&*self.session.key).map_err(|_| "Invalid IPC key")?;
        signer.update(format!("{DOMAIN}{}\n{encoded}", self.send_direction).as_bytes());
        let envelope = Envelope {
            format: "rc-ipc-v1".into(),
            payload: encoded,
            mac: URL_SAFE_NO_PAD.encode(signer.finalize().into_bytes()),
        };
        let mut bytes = serde_json::to_vec(&envelope).map_err(|_| "Invalid IPC JSON")?;
        bytes.push(b'\n');
        if bytes.len() > MAX_LINE_BYTES {
            return Err("IPC line too large".into());
        }
        self.send_seq += 1;
        Ok(bytes)
    }
    pub fn decode(&mut self, bytes: &[u8]) -> Result<IpcMessage, String> {
        let result = self.decode_inner(bytes);
        if result.is_err() {
            self.close();
        }
        result
    }
    fn decode_inner(&mut self, bytes: &[u8]) -> Result<IpcMessage, String> {
        if self.failed || self.recv_seq >= MAX_SEQUENCE {
            return Err("IPC closed".into());
        }
        let envelope: Envelope = serde_json::from_slice(line(bytes, MAX_LINE_BYTES)?)
            .map_err(|_| "Invalid IPC envelope")?;
        if envelope.format != "rc-ipc-v1" {
            return Err("Invalid IPC format".into());
        }
        let body = decode64(&envelope.payload)?;
        if body.len() > MAX_BODY_BYTES {
            return Err("IPC body too large".into());
        }
        let signature = decode64(&envelope.mac)?;
        let mut verifier =
            HmacSha256::new_from_slice(&*self.session.key).map_err(|_| "Invalid IPC key")?;
        verifier
            .update(format!("{DOMAIN}{}\n{}", self.recv_direction, envelope.payload).as_bytes());
        verifier
            .verify_slice(&signature)
            .map_err(|_| "IPC authentication failed")?;
        let body: Body = serde_json::from_slice(&body).map_err(|_| "Invalid IPC body")?;
        if body.session_id != self.session.session_id
            || body.launch_id != self.session.launch_id
            || body.seq != self.recv_seq + 1
            || body.seq > MAX_SEQUENCE
        {
            return Err("IPC launch/sequence mismatch".into());
        }
        if !kind(&body.kind) || !body.payload.is_object() {
            return Err("Invalid IPC message".into());
        }
        self.recv_seq = body.seq;
        Ok(IpcMessage {
            kind: body.kind,
            payload: body.payload,
            received_at: Instant::now(),
        })
    }
    fn close(&mut self) {
        self.failed = true;
        self.session.key.fill(0);
    }
}

/// Shared engine clock (CLOCK_MONOTONIC on Unix, QPC on Windows). Read the
/// kernel clock BEFORE computing Instant remaining time, so delay only shortens
/// authority and queued messages never extend the signed lease.
pub fn monotonic_deadline_ns(deadline: Instant) -> Result<String, &'static str> {
    let (current, _) = super::media_liveness::clock_sample()?;
    // Sample Instant again AFTER the engine clock; clock_sample's earlier
    // Instant is for progress timestamps and would extend a lease here.
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or("REMOTE_MEDIA_LEASE_EXPIRED")?;
    if remaining.is_zero() || remaining > std::time::Duration::from_secs(15) {
        return Err("REMOTE_MEDIA_LEASE_EXPIRED");
    }
    Ok((current as u128 + remaining.as_nanos()).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn pair() -> (IpcCodec, IpcCodec) {
        let session = IpcSession::new("77777777-7777-4777-8777-777777777777").unwrap();
        let clone = IpcSession {
            session_id: session.session_id.clone(),
            launch_id: session.launch_id.clone(),
            key: Zeroizing::new(*session.key),
        };
        (session.supervisor_codec(), IpcCodec::new(clone, true))
    }
    #[test]
    fn bidirectional_and_replay_terminal() {
        let (mut parent, mut child) = pair();
        let request = parent.encode("heartbeat", json!({})).unwrap();
        assert_eq!(child.decode(&request).unwrap().kind, "heartbeat");
        let response = child.encode("ready", json!({"protocolVersion":1})).unwrap();
        assert_eq!(
            parent.decode(&response).unwrap().payload,
            json!({"protocolVersion":1})
        );
        assert!(child.decode(&request).is_err());
        let next = parent.encode("stop", json!({})).unwrap();
        assert!(child.decode(&next).is_err());
        assert!(child.encode("stopped", json!({})).is_err());
    }
    #[test]
    fn tamper_reflection_and_cross_launch_fail() {
        let (mut a, mut b) = pair();
        let msg = a.encode("offer", json!({"sdp":"test"})).unwrap();
        assert!(a.decode(&msg).is_err());
        let (mut other, _) = pair();
        assert!(other.decode(&msg).is_err());
        let mut envelope: Value = serde_json::from_slice(&msg).unwrap();
        envelope["mac"] = json!(URL_SAFE_NO_PAD.encode([0u8; 32]));
        let mut bad = serde_json::to_vec(&envelope).unwrap();
        bad.push(b'\n');
        assert!(b.decode(&bad).is_err());
    }
    #[test]
    fn gaps_truncation_and_size_fail_closed() {
        let (mut a, mut b) = pair();
        a.encode("heartbeat", json!({})).unwrap();
        let second = a.encode("heartbeat", json!({})).unwrap();
        assert!(b.decode(&second).is_err());
        let (mut a, mut b) = pair();
        let msg = a.encode("heartbeat", json!({})).unwrap();
        assert!(b.decode(&msg[..msg.len() - 1]).is_err());
        assert!(a
            .encode("offer", json!({"sdp":"x".repeat(MAX_BODY_BYTES)}))
            .is_err());
        assert!(a.encode("stop", json!({})).is_err());
        let (_, mut b) = pair();
        assert!(b.decode(&[]).is_err());
    }
    #[test]
    fn shared_python_vector() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/remote-control-ipc-v1.json"
        ))
        .unwrap();
        let bootstrap: Bootstrap = serde_json::from_value(fixture["bootstrap"].clone()).unwrap();
        let session = IpcSession {
            session_id: bootstrap.session_id,
            launch_id: bootstrap.launch_id,
            key: Zeroizing::new(decode64(&bootstrap.key).unwrap().try_into().unwrap()),
        };
        let mut parent = session.supervisor_codec();
        let encoded = parent.encode("heartbeat", json!({"sample":1})).unwrap();
        assert_eq!(
            std::str::from_utf8(&encoded).unwrap(),
            fixture["supervisorLine"].as_str().unwrap()
        );
        let received = parent
            .decode(fixture["engineLine"].as_str().unwrap().as_bytes())
            .unwrap();
        assert_eq!(received.kind, "ready");
    }
    #[test]
    fn authenticated_nested_duplicate_fields_are_rejected() {
        let (parent, mut child) = pair();
        let raw = format!(
            r#"{{"sessionId":"{}","launchId":"{}","seq":1,"kind":"offer","payload":{{"nested":[{{"sdp":"one","sdp":"two"}}]}}}}"#,
            parent.session.session_id, parent.session.launch_id
        );
        let payload = URL_SAFE_NO_PAD.encode(raw);
        let mut mac = HmacSha256::new_from_slice(&*parent.session.key).unwrap();
        mac.update(format!("{DOMAIN}supervisor-to-engine\n{payload}").as_bytes());
        let mut frame = serde_json::to_vec(&Envelope {
            format: "rc-ipc-v1".into(),
            payload,
            mac: URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()),
        })
        .unwrap();
        frame.push(b'\n');
        assert!(child.decode(&frame).is_err());
        assert!(child.encode("ready", json!({})).is_err());
    }
    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn expired_or_unbounded_deadline_is_rejected() {
        assert!(monotonic_deadline_ns(Instant::now()).is_err());
        assert!(
            monotonic_deadline_ns(Instant::now() + std::time::Duration::from_secs(16)).is_err()
        );
        assert!(
            monotonic_deadline_ns(Instant::now() + std::time::Duration::from_secs(1))
                .unwrap()
                .parse::<u128>()
                .is_ok()
        );
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn media_deadline_uses_windows_engine_clock_without_extending_lease() {
        let deadline = Instant::now() + std::time::Duration::from_secs(15);
        let before = super::super::media_liveness::clock_sample().unwrap().0 as u128;
        let converted = monotonic_deadline_ns(deadline)
            .unwrap()
            .parse::<u128>()
            .unwrap();
        let (after, sampled_at) = super::super::media_liveness::clock_sample().unwrap();
        assert!(converted > before);
        assert!(converted <= after as u128 + deadline.duration_since(sampled_at).as_nanos());
    }
}
