//! The only production bundle entry point takes the native Tauri application.
//! Build-time selection pins the exact manifest; no runtime environment or web
//! parameter supplies a resource root, interpreter, script or loader search path.
#![allow(dead_code)]
use super::engine_bundle_format::{self as format, VerifiedTree};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;
const SELECTED: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/remote-control-engine-manifest.json"
));
const TARGET: &str = env!("TODE_REMOTE_ENGINE_TARGET");

pub(super) fn is_configured() -> bool {
    SELECTED != b"[]"
}

/// Preserve a useful category without sending filesystem paths to the WebView.
pub(super) fn presence_error(reason: &str) -> &'static str {
    if reason.contains("manifest differs") { "REMOTE_ENGINE_MANIFEST_CHANGED" }
    else if reason.contains("hash mismatch") || reason.contains("size mismatch") || reason.contains("changed while reading") { "REMOTE_ENGINE_CONTENT_CHANGED" }
    else if reason.contains("unlisted resource") { "REMOTE_ENGINE_UNLISTED_RESOURCE" }
    else if reason.contains("resource missing") || reason.contains("unreadable") || reason.contains("inaccessible") || reason.contains("directory unavailable") || reason.contains("directory unreadable") || reason.contains("root must be") { "REMOTE_ENGINE_RESOURCE_UNREADABLE" }
    else if reason.contains("permissions") || reason.contains("reparse") || reason.contains("hard link") || reason.contains("writable resource") { "REMOTE_ENGINE_RESOURCE_UNSAFE" }
    else if reason == "REMOTE_ENGINE_NOT_CONFIGURED" { "REMOTE_ENGINE_NOT_CONFIGURED" }
    else { "REMOTE_ENGINE_BUNDLE_REJECTED" }
}

pub(super) struct TrustedEngineBundle {
    root: PathBuf,
    _verified: VerifiedTree,
}
impl TrustedEngineBundle {
    pub fn from_app(app: &tauri::AppHandle) -> format::Result<Self> {
        if SELECTED == b"[]" {
            return Err("REMOTE_ENGINE_NOT_CONFIGURED".into());
        }
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|_| "REMOTE_ENGINE_RESOURCES_UNAVAILABLE")?;
        Self::from_resource_dir(&resource_dir)
    }
    fn from_resource_dir(resources: &Path) -> format::Result<Self> {
        if SELECTED == b"[]" {
            return Err("REMOTE_ENGINE_NOT_CONFIGURED".into());
        }
        let resources = resources
            .canonicalize()
            .map_err(|_| "REMOTE_ENGINE_RESOURCES_UNAVAILABLE")?;
        let root = resources.join(format::RESOURCE_DIRECTORY);
        let verified = format::verify(&root, SELECTED, TARGET)?;
        if verified.root != root {
            return Err("REMOTE_ENGINE_RESOURCE_ESCAPE".into());
        }
        Ok(Self { root, _verified: verified })
    }
    fn verify(&self) -> format::Result<VerifiedTree> {
        format::verify(&self.root, SELECTED, TARGET)
    }
    pub fn command(&self) -> format::Result<Command> {
        // Recheck the complete dependency closure immediately before spawn.
        let verified = self.verify()?;
        let mut command = Command::new(&verified.entrypoint);
        command.env_clear().current_dir(&verified.root);
        // No argv, user site, PYTHONPATH, DYLD_* or GStreamer search override is
        // accepted. The hashed native launcher establishes its isolated runtime.
        Ok(command)
    }
    pub fn digest(&self) -> format::Result<String> {
        // from_app already verified the complete tree; command rechecks before spawn.
        Ok(self._verified.digest.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presence_reports_the_resource_failure_category() {
        for (reason, code) in [
            ("REMOTE_ENGINE_BUNDLE: manifest differs from compiled trust anchor", "REMOTE_ENGINE_MANIFEST_CHANGED"),
            ("REMOTE_ENGINE_BUNDLE: resource hash mismatch: app/entry.py", "REMOTE_ENGINE_CONTENT_CHANGED"),
            ("REMOTE_ENGINE_BUNDLE: unlisted resource", "REMOTE_ENGINE_UNLISTED_RESOURCE"),
            ("REMOTE_ENGINE_BUNDLE: resource missing, writable or inaccessible", "REMOTE_ENGINE_RESOURCE_UNREADABLE"),
            ("REMOTE_ENGINE_BUNDLE: resource type or reparse point rejected", "REMOTE_ENGINE_RESOURCE_UNSAFE"),
        ] { assert_eq!(presence_error(reason), code); }
    }
    #[test]
    fn absent_build_selection_fails_closed_without_reading_runtime_paths() {
        if SELECTED == b"[]" {
            assert!(
                matches!(TrustedEngineBundle::from_resource_dir(Path::new("/nonexistent-resource-root")),Err(error) if error=="REMOTE_ENGINE_NOT_CONFIGURED")
            );
        }
    }
    #[test]
    #[ignore = "Requires an explicitly selected candidate and packaged .app Resources directory; reads only, never starts the engine"]
    fn selected_app_resources_match_compiled_manifest() {
        assert_ne!(SELECTED, b"[]", "set build-time TODE_REMOTE_ENGINE_BUNDLE");
        let resources = std::env::var_os("TODE_TEST_APP_RESOURCES")
            .expect("set test-only TODE_TEST_APP_RESOURCES");
        let bundle = TrustedEngineBundle::from_resource_dir(Path::new(&resources)).unwrap();
        let command = bundle.command().unwrap();
        assert_eq!(
            command.get_program(),
            bundle.root.join("bin/remote-control-engine")
        );
        assert_eq!(command.get_args().count(), 0);
        assert_eq!(command.get_current_dir(), Some(bundle.root.as_path()));
    }
}
