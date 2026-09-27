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

pub(super) struct TrustedEngineBundle {
    root: PathBuf,
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
        Ok(Self { root })
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
        Ok(self.verify()?.digest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
