#[path = "src/remote_control/engine_bundle_format.rs"]
mod engine_bundle_format;

fn main() {
    println!("cargo:rerun-if-changed=remote-control-trusted-keys.json");
    println!("cargo:rerun-if-changed=remote-control-sidecars.json");
    println!("cargo:rerun-if-env-changed=TODE_REMOTE_ENGINE_BUNDLE");
    println!("cargo:rerun-if-changed=src/remote_control/engine_bundle_format.rs");
    println!("cargo:rerun-if-changed=src/remote_control/windows_engine_bundle.rs");
    let legacy: serde_json::Value = serde_json::from_slice(
        &std::fs::read("remote-control-sidecars.json").expect("read legacy sidecar selection"),
    )
    .expect("valid sidecar selection");
    assert_eq!(
        legacy,
        serde_json::json!([]),
        "Per-program sidecar trust is obsolete; select a complete engine bundle"
    );
    let target = std::env::var("TARGET").expect("Cargo target");
    println!("cargo:rustc-env=TODE_REMOTE_ENGINE_TARGET={target}");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    println!("cargo:rerun-if-env-changed=TODE_REMOTE_DEV_PUBLIC_KEY");
    let mut trusted_keys: Vec<serde_json::Value> = serde_json::from_slice(
        &std::fs::read("remote-control-trusted-keys.json").expect("read trusted keys"),
    ).expect("valid trusted keys");
    if let Some(path) = std::env::var_os("TODE_REMOTE_DEV_PUBLIC_KEY") {
        assert_eq!(std::env::var("PROFILE").as_deref(), Ok("debug"), "Development trust is debug-only");
        let path = std::path::PathBuf::from(path);
        println!("cargo:rerun-if-changed={}", path.display());
        let key: serde_json::Value = serde_json::from_slice(&std::fs::read(path).expect("read development public key"))
            .expect("valid development public key");
        if !trusted_keys.iter().any(|existing| existing["keyId"] == key["keyId"]) {
            trusted_keys.push(key);
        }
    }
    std::fs::write(out.join("remote-control-trusted-keys.json"), serde_json::to_vec(&trusted_keys).unwrap())
        .expect("embed trusted public keys");
    let selected = match std::env::var_os("TODE_REMOTE_ENGINE_BUNDLE") {
        None => b"[]".to_vec(),
        Some(path) => {
            assert!(
                std::env::var_os("CARGO_FEATURE_REMOTE_CONTROL_HARNESS").is_none(),
                "A packaged engine and the development harness cannot be selected together"
            );
            let path = std::path::PathBuf::from(path);
            assert!(
                path.is_absolute(),
                "TODE_REMOTE_ENGINE_BUNDLE must be an absolute build-time path"
            );
            let bytes =
                engine_bundle_format::read_manifest(&path).expect("read engine bundle manifest");
            let verified = engine_bundle_format::verify(&path, &bytes, &target)
                .expect("verify entire engine bundle");
            println!(
                "cargo:rerun-if-changed={}",
                path.join(engine_bundle_format::MANIFEST_FILE).display()
            );
            for file in &verified.manifest.files {
                println!("cargo:rerun-if-changed={}", path.join(&file.path).display());
            }
            println!("cargo:warning=Selected remote engine {} ({} verified files); runtime handshake and release policy required", verified.digest, verified.manifest.files.len());
            bytes
        }
    };
    std::fs::write(out.join("remote-control-engine-manifest.json"), &selected)
        .expect("embed engine manifest");
    // App commands otherwise bypass the per-window capability allowlist.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "screen_share_sources",
            "screen_share_preview",
            "screen_share_start",
            "screen_share_frame",
            "screen_share_present",
            "screen_share_stop",
            "remote_control_capabilities",
            "remote_control_open_permission_settings",
            "remote_control_stop",
            "remote_control_register_device",
            "remote_control_identify_device",
            "remote_control_bind_controller",
            "remote_control_confirm_request",
            "remote_control_clear_remembered_approvals",
            "remote_control_list_remembered_approvals",
            "remote_control_remove_remembered_approval",
            "remote_control_reset_identity",
            "remote_control_presence",
            "remote_control_start_host",
            "remote_control_host_command",
        ]),
    ))
    .expect("failed to build desktop command permissions");
}
