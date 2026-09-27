//! Native-only, device-signed remembered choices. The webview can clear these,
//! but cannot create them. A changed identity or scope always needs a new choice.
use super::{authorization::Scope, identity::Decision};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const DOMAIN: &[u8] = b"todesk-remembered-consent/v1\n";
const MAX_BYTES: u64 = 128 * 1024;
const MAX_ENTRIES: usize = 64;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub host_user: u64,
    pub host_device: String,
    pub host_auth_version: String,
    pub host_key_version: u64,
    pub host_key_fingerprint: String,
    pub controller_user: u64,
    pub controller_auth_version: String,
    pub screen: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    binding: Binding,
    scope: Scope,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    choice: Choice,
    signature: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Preferences {
    entries: Vec<Entry>,
}
fn message(choice: &Choice) -> Vec<u8> {
    [
        DOMAIN,
        serde_json::to_vec(choice)
            .expect("fixed consent fields")
            .as_slice(),
    ]
    .concat()
}
impl Preferences {
    pub fn load(path: &Path) -> Self {
        let result = (|| {
            let file = fs::File::open(path).ok()?;
            if file.metadata().ok()?.len() > MAX_BYTES {
                return None;
            }
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
            let value: Self = serde_json::from_slice(&bytes).ok()?;
            (bytes.len() as u64 <= MAX_BYTES && value.entries.len() <= MAX_ENTRIES).then_some(value)
        })();
        result.unwrap_or_default() // Missing/unreadable/corrupt memory means prompt again.
    }
    pub fn decision(
        &self,
        binding: &Binding,
        requested: Scope,
        key: &VerifyingKey,
    ) -> Option<Decision> {
        self.entries.iter().find_map(|entry| {
            if &entry.choice.binding != binding
                || (requested == Scope::Control && entry.choice.scope != Scope::Control)
            {
                return None;
            }
            let bytes = URL_SAFE_NO_PAD.decode(&entry.signature).ok()?;
            let signature = Signature::from_slice(&bytes).ok()?;
            key.verify_strict(&message(&entry.choice), &signature)
                .ok()?;
            Some(if requested == Scope::Control {
                Decision::Control
            } else {
                Decision::View
            })
        })
    }
    pub fn remember(
        &mut self,
        binding: Binding,
        decision: Decision,
        checked: bool,
        key: &SigningKey,
    ) -> bool {
        if !checked || decision == Decision::Reject {
            return false;
        }
        let scope = if decision == Decision::Control {
            Scope::Control
        } else {
            Scope::View
        };
        self.entries.retain(|e| e.choice.binding != binding);
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.remove(0);
        }
        let choice = Choice { binding, scope };
        let signature = URL_SAFE_NO_PAD.encode(key.sign(&message(&choice)).to_bytes());
        self.entries.push(Entry { choice, signature });
        true
    }
    pub fn save(&self, path: &Path) -> Result<(), &'static str> {
        let result = (|| -> std::io::Result<()> {
            let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
            fs::create_dir_all(parent)?;
            let bytes = serde_json::to_vec(self)?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            let mut random = [0; 16];
            getrandom::getrandom(&mut random)
                .map_err(|_| std::io::Error::other("random unavailable"))?;
            let temporary = parent.join(format!(".consent-{}.tmp", URL_SAFE_NO_PAD.encode(random)));
            let write = (|| -> std::io::Result<()> {
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, path)
            })();
            if write.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            write
        })();
        result.map_err(|_| "REMOTE_CONSENT_MEMORY_UNAVAILABLE")
    }
    pub fn clear(path: &Path) -> Result<(), &'static str> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("REMOTE_CONSENT_MEMORY_UNAVAILABLE"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            host_user: 1,
            host_device: "device-a".into(),
            host_auth_version: "host-auth".into(),
            host_key_version: 1,
            host_key_fingerprint: "fingerprint".into(),
            controller_user: 2,
            controller_auth_version: "controller-auth".into(),
            screen: "primary".into(),
        }
    }
    #[test]
    fn only_checked_allow_is_remembered() {
        let key = SigningKey::from_bytes(&[9; 32]);
        for (decision, checked, saved) in [
            (Decision::Reject, true, false),
            (Decision::Reject, false, false),
            (Decision::View, false, false),
            (Decision::Control, false, false),
            (Decision::View, true, true),
            (Decision::Control, true, true),
        ] {
            let mut prefs = Preferences::default();
            assert_eq!(prefs.remember(binding(), decision, checked, &key), saved);
            assert_eq!(
                prefs
                    .decision(&binding(), Scope::View, &key.verifying_key())
                    .is_some(),
                saved
            );
        }
    }
    #[test]
    fn remembered_view_never_grants_control_and_control_can_answer_view() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let mut prefs = Preferences::default();
        prefs.remember(binding(), Decision::View, true, &key);
        assert_eq!(
            prefs.decision(&binding(), Scope::Control, &key.verifying_key()),
            None
        );
        prefs.remember(binding(), Decision::Control, true, &key);
        assert_eq!(
            prefs.decision(&binding(), Scope::View, &key.verifying_key()),
            Some(Decision::View)
        );
        assert_eq!(
            prefs.decision(&binding(), Scope::Control, &key.verifying_key()),
            Some(Decision::Control)
        );
    }
    #[test]
    fn other_users_devices_auth_versions_and_tampering_require_prompt() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let mut prefs = Preferences::default();
        prefs.remember(binding(), Decision::Control, true, &key);
        let original = binding();
        let variants = [
            Binding {
                host_user: 3,
                ..original.clone()
            },
            Binding {
                controller_user: 3,
                ..original.clone()
            },
            Binding {
                host_device: "device-b".into(),
                ..original.clone()
            },
            Binding {
                host_key_version: 2,
                ..original.clone()
            },
            Binding {
                host_auth_version: "new".into(),
                ..original.clone()
            },
            Binding {
                controller_auth_version: "new".into(),
                ..original.clone()
            },
            Binding {
                screen: "other".into(),
                ..original.clone()
            },
        ];
        for changed in variants {
            assert_eq!(
                prefs.decision(&changed, Scope::View, &key.verifying_key()),
                None
            );
        }
        assert_eq!(
            prefs.decision(
                &original,
                Scope::View,
                &SigningKey::from_bytes(&[8; 32]).verifying_key()
            ),
            None
        );
        prefs.entries[0].choice.binding.controller_user = 3;
        assert_eq!(
            prefs.decision(
                &Binding {
                    controller_user: 3,
                    ..original
                },
                Scope::View,
                &key.verifying_key()
            ),
            None
        );
    }
    #[test]
    fn persists_across_reload_and_clear_restores_prompt() {
        let directory = std::env::temp_dir().join(format!(
            "todesk-consent-test-{}-{}",
            std::process::id(),
            super::super::identity::wall_ms().unwrap()
        ));
        let path = directory.join("choices.json");
        let key = SigningKey::from_bytes(&[9; 32]);
        let mut prefs = Preferences::default();
        prefs.remember(binding(), Decision::View, true, &key);
        prefs.save(&path).unwrap();
        assert_eq!(
            Preferences::load(&path).decision(&binding(), Scope::View, &key.verifying_key()),
            Some(Decision::View)
        );
        Preferences::clear(&path).unwrap();
        assert_eq!(
            Preferences::load(&path).decision(&binding(), Scope::View, &key.verifying_key()),
            None
        );
        fs::write(&path, b"corrupt").unwrap();
        assert_eq!(
            Preferences::load(&path).decision(&binding(), Scope::View, &key.verifying_key()),
            None
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
