//! Network access needs a server signature bound to the current native consent.
//! TURN credentials permit relay allocation only; media still needs its own lease.
use super::{
    authorization::{Endpoint, LocalConsent, PinnedKeys, SignedEnvelope},
    host_runtime::HostResult,
};
use serde::{Deserialize, Serialize};
use std::{
    net::IpAddr,
    time::Instant,
};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum CandidatePolicy {
    #[default]
    Loopback,
    All,
    Relay,
}
impl CandidatePolicy {
    // relay constrains our local candidates, not the other peer's policy.
    pub(super) fn remote(self) -> Self {
        if self == Self::Loopback {
            Self::Loopback
        } else {
            Self::All
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IceServer {
    urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claims {
    protocol_version: u32,
    issuer: String,
    audience: String,
    purpose: String,
    session_id: String,
    host: Endpoint,
    controller: Endpoint,
    issued_at: u64,
    expires_at: u64,
    session_expires_at: u64,
    ice_servers: Vec<IceServer>,
    ice_transport_policy: String,
}
pub(super) fn verify(
    keys: &PinnedKeys,
    proof: &SignedEnvelope,
    local: &LocalConsent,
    wall: u64,
    now: Instant,
) -> HostResult<(CandidatePolicy, serde_json::Value)> {
    let (bytes, before, after) = keys
        .verify_payload(proof, wall)
        .map_err(|_| "REMOTE_ICE_SIGNATURE")?;
    let c: Claims = serde_json::from_slice(&bytes).map_err(|_| "REMOTE_ICE_CONFIGURATION")?;
    if c.protocol_version != 1
        || c.issuer != "todesk-remote-control"
        || c.audience != "todesk-native-ice"
        || c.purpose != "ice-config"
        || c.session_id != local.session_id
        || c.host != local.host
        || c.controller != local.controller
        || c.issued_at > wall
        || c.issued_at < before
        || c.session_expires_at <= wall
        || c.expires_at > after
        || c.session_expires_at.saturating_sub(c.issued_at) > 3_600_000
        || c.expires_at <= c.session_expires_at
        || c.expires_at - c.session_expires_at > 300_000
        || now >= local.deadline
        // Compare the two signed server deadlines directly. Their separate
        // receive-time clocks can have different network delays.
        || c.session_expires_at > local.server_expires_at
        || c.ice_servers.len() > 4
    {
        return Err("REMOTE_ICE_CONFIGURATION");
    }
    let policy = match c.ice_transport_policy.as_str() {
        "all" => CandidatePolicy::All,
        "relay" => CandidatePolicy::Relay,
        _ => return Err("REMOTE_ICE_CONFIGURATION"),
    };
    let mut has_turn = false;
    for server in &c.ice_servers {
        if server.urls.is_empty() || server.urls.len() > 4 {
            return Err("REMOTE_ICE_CONFIGURATION");
        }
        let turn = server.urls[0].starts_with("turn");
        for url in &server.urls {
            if !valid_url(url) || url.starts_with("turn") != turn {
                return Err("REMOTE_ICE_CONFIGURATION");
            }
        }
        let valid_secret = |v: &Option<String>| {
            v.as_ref().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| (33..=126).contains(&b))
            })
        };
        if (turn && (!valid_secret(&server.username) || !valid_secret(&server.credential)))
            || (!turn && (server.username.is_some() || server.credential.is_some()))
        {
            return Err("REMOTE_ICE_CONFIGURATION");
        }
        has_turn |= turn;
    }
    if policy == CandidatePolicy::Relay && !has_turn {
        return Err("REMOTE_ICE_CONFIGURATION");
    }
    Ok((
        policy,
        serde_json::json!({"iceServers": c.ice_servers, "iceTransportPolicy": c.ice_transport_policy, "expiresAt": c.expires_at}),
    ))
}
fn valid_url(url: &str) -> bool {
    if url.len() > 512 {
        return false;
    }
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    let address = match scheme {
        "stun" => rest,
        "turn" | "turns" => {
            let Some((address, transport)) = rest.split_once("?transport=") else {
                return false;
            };
            if !matches!(transport, "udp" | "tcp") || (scheme == "turns" && transport != "tcp") {
                return false;
            }
            address
        }
        _ => return false,
    };
    let Some((host, port)) = address.rsplit_once(':') else {
        return false;
    };
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && !port.is_empty()
        && port.bytes().all(|b| b.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|p| p > 0)
}
pub(super) fn candidate(candidate: &str, policy: CandidatePolicy) -> HostResult<()> {
    let p: Vec<_> = candidate.split_whitespace().collect();
    if candidate.len() > 4096
        || candidate.contains(['\r', '\n', '\0'])
        || p.len() < 8
        || !p[0].starts_with("candidate:")
        || p[0].len() <= 10
        || p[1] != "1"
        || p[6] != "typ"
        || !matches!(p[2].to_ascii_lowercase().as_str(), "udp" | "tcp")
        || !p[3].parse::<u32>().is_ok_and(|n| n > 0)
        || !p[5].parse::<u16>().is_ok_and(|n| n > 0)
        || !matches!(p[7], "host" | "srflx" | "prflx" | "relay")
        || (p.len() - 8) % 2 != 0
    {
        return Err("REMOTE_ICE_REJECTED");
    }
    let address: IpAddr = p[4].parse().map_err(|_| "REMOTE_ICE_REJECTED")?;
    if address.is_unspecified()
        || address.is_multicast()
        || (policy == CandidatePolicy::Relay && p[7] != "relay")
        || (policy == CandidatePolicy::Loopback && (!address.is_loopback() || p[7] != "host"))
    {
        return Err("REMOTE_ICE_REJECTED");
    }
    for pair in p[8..].chunks_exact(2) {
        if (policy == CandidatePolicy::Loopback && matches!(pair[0], "raddr" | "rport"))
            || (pair[0] == "raddr" && pair[1].parse::<IpAddr>().is_err())
            || (pair[0] == "rport" && pair[1].parse::<u16>().is_err())
        {
            return Err("REMOTE_ICE_REJECTED");
        }
    }
    Ok(())
}
