//! Native authorization, supervision and product transport adapters. Release
//! admission remains disabled until product validation. No webview boolean
//! can create a LocalConsent or prove transport readiness.

mod authorization;
mod consent_dialog;
mod consent_memory;
mod device_store;
mod engine_bundle;
mod engine_bundle_format;
mod guard;
#[cfg(feature = "remote-control-harness")]
mod harness;
mod host_process;
mod host_runtime;
mod host_transport;
mod input;
mod ipc;
mod media_layout;
mod media_liveness;
#[cfg(feature = "remote-control-harness")]
pub fn run_host_harness() -> Result<(), &'static str> {
    harness::run()
}
mod ice;
mod identity;
mod native_host;
mod native_presence;
mod platform;
#[cfg(all(feature = "remote-control-harness", not(debug_assertions)))]
compile_error!("remote-control-harness is a debug-only development binary; never enable it in a packaged release");

use serde::Serialize;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlCapabilities {
    runtime: &'static str,
    platform: &'static str,
    os_version: String,
    arch: &'static str,
    protocol_version: u32,
    engine_ready: bool,
    can_capture: bool,
    can_inject_input: bool,
    device_registration_ready: bool,
    device_identification_ready: bool,
    device_identity_reset_ready: bool,
    consent_prompt_ready: bool,
    permissions: Permissions,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Permissions {
    screen_capture: &'static str,
    input_control: &'static str,
}

#[derive(Default)]
pub struct RemoteControlState {
    host: Mutex<Option<host_runtime::HostSupervisor>>,
    identity: Arc<Mutex<identity::IdentityState>>,
    bridge: Mutex<Option<native_host::NativeHostBridge>>,
    engine_ready: OnceLock<bool>,
    consent_memory_epoch: Arc<Mutex<u64>>,
}

impl RemoteControlState {
    pub fn stop(&self) -> Result<(), &'static str> {
        self.bridge
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .take();
        self.identity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stop();
        self.stop_host()
    }
    fn stop_host(&self) -> Result<(), &'static str> {
        let mut host = self.host.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        if let Some(host) = host.as_mut() {
            host.stop(guard::StopReason::LocalStop)?;
        }
        *host = None;
        Ok(())
    }
    /// The trusted native transport adapter is the sole caller; no invoke can
    /// supply a driver, consent, trust anchor, readiness, or OS executor.
    #[allow(clippy::too_many_arguments)]
    fn connect_native_host(
        &self,
        connection: &authorization::SignedEnvelope,
        transport: &mut host_transport::HostTransport,
        mut driver: Box<dyn host_runtime::MediaDriver>,
        input: Box<dyn input::InputExecutor>,
        probe: host_runtime::AvailabilityProbe,
    ) -> Result<Arc<Mutex<host_runtime::HostRuntime>>, &'static str> {
        if !transport.belongs_to(&self.identity) {
            let _ = driver.terminate();
            return Err("REMOTE_LOCAL_CONSENT_REQUIRED");
        }
        let prepared = (|| {
            let mut slot = self.host.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
            if let Some(host) = slot.as_mut() {
                if !host
                    .runtime()
                    .lock()
                    .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
                    .ended()
                {
                    return Err("REMOTE_LOCAL_SESSION_BUSY");
                }
                host.stop(guard::StopReason::LocalStop)?;
                *slot = None;
            }
            Ok((slot, identity::trusted_keys()?, identity::wall_ms()?))
        })();
        let (mut slot, keys, now_ms) = match prepared {
            Ok(value) => value,
            Err(error) => {
                let _ = driver.terminate();
                return Err(error);
            }
        };
        let runtime = transport.connect(
            keys,
            connection,
            driver,
            input,
            probe,
            now_ms,
            Instant::now(),
        )?;
        let host = host_runtime::HostSupervisor::spawn(runtime);
        let runtime = host.runtime();
        *slot = Some(host);
        Ok(runtime)
    }
}

#[tauri::command]
pub async fn remote_control_presence(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    proof: authorization::SignedEnvelope,
) -> Result<authorization::SignedEnvelope, &'static str> {
    require_main_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        if std::env::consts::OS != "macos" {
            return Err("PLATFORM_UNSUPPORTED");
        }
        let engine = engine_bundle::TrustedEngineBundle::from_app(&app)
            .map_err(|_| "REMOTE_ENGINE_NOT_READY")?;
        let digest = engine.digest().map_err(|_| "REMOTE_ENGINE_NOT_READY")?;
        let (capture, input) = platform::permissions();
        native_presence::prove(
            &device_store::OsSeedStore,
            &identity::trusted_keys()?,
            &proof,
            digest,
            capture == platform::PermissionState::Granted,
            input == platform::PermissionState::Granted,
            identity::wall_ms()?,
        )
    })
    .await
    .map_err(|_| "REMOTE_NATIVE_WORKER_FAILED")?
}

#[tauri::command]
pub async fn remote_control_start_host(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    ice_proof: authorization::SignedEnvelope,
    events: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), &'static str> {
    require_main_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        if std::env::consts::OS != "macos" {
            return Err("PLATFORM_UNSUPPORTED");
        }
        let state = app.state::<RemoteControlState>();
        let mut slot = state
            .bridge
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        if slot.as_ref().is_some_and(|bridge| bridge.alive()) {
            return Err("REMOTE_LOCAL_SESSION_BUSY");
        }
        slot.take();
        let mut prepared = host_transport::PreparedHost::bundled(&app, state.identity.clone())?;
        prepared.configure_ice(
            &identity::trusted_keys()?,
            &ice_proof,
            identity::wall_ms()?,
            Instant::now(),
        )?;
        *slot = Some(native_host::launch(app.clone(), prepared, events)?);
        Ok(())
    })
    .await
    .map_err(|_| "REMOTE_NATIVE_WORKER_FAILED")?
}

#[tauri::command]
pub fn remote_control_host_command(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, RemoteControlState>,
    session_id: String,
    command: native_host::HostCommand,
) -> Result<(), &'static str> {
    require_main_window(window.label())?;
    let slot = state
        .bridge
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
    let bridge = slot
        .as_ref()
        .filter(|bridge| bridge.session_id == session_id)
        .ok_or("REMOTE_HOST_STOPPED")?;
    bridge.send(command)
}

#[tauri::command]
pub async fn remote_control_capabilities(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<RemoteControlCapabilities, &'static str> {
    require_main_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RemoteControlState>();
        let ready = *state.engine_ready.get_or_init(|| {
            std::env::consts::OS == "macos"
                && platform::probe().candidate_platform
                && host_process::ProcessMediaDriver::probe_bundled(&app).is_ok()
        });
        capabilities(ready)
    }).await.map_err(|_| "REMOTE_NATIVE_WORKER_FAILED")
}

fn capabilities(engine_ready: bool) -> RemoteControlCapabilities {
    let probe = platform::probe();
    let engine_ready = engine_ready && probe.candidate_platform && probe.platform == "macos";
    RemoteControlCapabilities {
        runtime: "tauri",
        platform: probe.platform,
        os_version: probe.os_version,
        arch: probe.arch,
        protocol_version: guard::PROTOCOL_VERSION,
        // Only the authenticated bundled-engine handshake supplies readiness.
        // TCC is separately reported and rechecked for every running session.
        engine_ready,
        can_capture: engine_ready,
        can_inject_input: engine_ready,
        device_registration_ready: probe.candidate_platform,
        device_identification_ready: probe.candidate_platform,
        device_identity_reset_ready: probe.candidate_platform,
        consent_prompt_ready: probe.candidate_platform
            && identity::trusted_keys()
                .ok()
                .zip(identity::wall_ms().ok())
                .is_some_and(|(keys, now)| keys.has_current_key(now)),
        permissions: Permissions {
            screen_capture: probe.screen_capture.as_str(),
            input_control: probe.input_control.as_str(),
        },
        reason: if engine_ready {
            "READY"
        } else if probe.candidate_platform {
            "ENGINE_NOT_READY"
        } else {
            "PLATFORM_UNSUPPORTED"
        },
    }
}

/// The only registration signature operation. Payload, platform and public key
/// are built by native code; the key remains in the OS store/native memory.
#[tauri::command]
pub async fn remote_control_register_device(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, RemoteControlState>,
    challenge: identity::DeviceChallenge,
    alias: String,
) -> Result<identity::RegistrationProof, &'static str> {
    require_main_window(window.label())?;
    let state = state.identity.clone();
    let operation = state
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .begin()?;
    let worker_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = identity::register(
            &device_store::OsSeedStore,
            challenge,
            alias,
            identity::wall_ms()?,
        );
        worker_state
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .check(operation)?;
        result
    })
    .await
    .map_err(|_| "REMOTE_NATIVE_WORKER_FAILED");
    state
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .finish(operation)?;
    result?
}

#[tauri::command]
pub async fn remote_control_identify_device(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, RemoteControlState>,
    challenge: identity::DeviceChallenge,
) -> Result<identity::DeviceIdentityProof, &'static str> {
    require_main_window(window.label())?;
    let state = state.identity.clone();
    let operation = state
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .begin()?;
    let worker_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = identity::identify(
            &device_store::OsSeedStore,
            challenge,
            identity::wall_ms()?,
        );
        worker_state
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .check(operation)?;
        result
    })
    .await
    .map_err(|_| "REMOTE_NATIVE_WORKER_FAILED");
    state
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .finish(operation)?;
    result?
}

/// Verify the compiled trust anchor and device binding before showing a native
/// OS dialog. Neither the dialog's decision nor its text is invoke-controlled.
#[tauri::command]
pub async fn remote_control_confirm_request(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteControlState>,
    request: authorization::SignedEnvelope,
) -> Result<identity::ConsentResponse, &'static str> {
    require_main_window(window.label())?;
    let keys = identity::trusted_keys()?;
    let memory_epoch = state.consent_memory_epoch.clone();
    let memory_path = consent_memory_path(&app)?;
    let state = state.identity.clone();
    let operation = state
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .begin()?;
    let worker_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let verified = identity::VerifiedApproval::verify(
            &device_store::OsSeedStore,
            &keys,
            &request,
            identity::wall_ms()?,
            Instant::now(),
        )?;
        let verified = worker_state
            .lock()
            .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
            .prepare(operation, verified, Instant::now())?;
        let grant_control = verified.is_grant_control();
        let (epoch, remembered) = {
            let epoch = memory_epoch.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
            (*epoch, verified.remembered_choice(&consent_memory::Preferences::load(&memory_path)))
        };
        let choice = if let Some(decision) = remembered {
            consent_dialog::Choice { decision, remember: false }
        } else {
            window.show().map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
            window.unminimize().map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
            window.set_focus().map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
            consent_dialog::show(&window, verified.consent_prompt())?
        };
        let decision = if grant_control && choice.decision != identity::Decision::Control {
            identity::Decision::Reject
        } else { choice.decision };
        // Clear and approval commit serialize here. A reset during the prompt
        // or after a remembered lookup cancels this approval, never recreates it.
        let memory_guard = memory_epoch.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        if *memory_guard != epoch { return Err("REMOTE_OPERATION_CANCELLED"); }
        let mut native_identity = worker_state.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        let mut preferences = consent_memory::Preferences::load(&memory_path);
        // Expired/cancelled/replayed operations must pass native approval before
        // any signed remembered choice is written to disk.
        let (response, save) = native_identity.approve_with_memory(
            operation, verified, choice, &mut preferences, identity::wall_ms()?, Instant::now(),
        )?;
        if save {
            if let Err(error) = preferences.save(&memory_path) {
                native_identity.stop();
                return Err(error);
            }
        }
        drop(native_identity);
        drop(memory_guard);
        if grant_control && decision == identity::Decision::Control {
            let native = app.state::<RemoteControlState>();
            let host = native.host.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
            if let Some(host) = host.as_ref() {
                let shared = host.runtime();
                let mut runtime = shared.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
                if let Err(error) = runtime.refresh_local_consent(Instant::now()) {
                    let _ = runtime.stop(guard::StopReason::NotAuthorized);
                    return Err(error);
                }
            }
        }
        Ok(response)
    })
    .await
    .map_err(|_| "REMOTE_NATIVE_WORKER_FAILED");
    state
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .finish(operation)?;
    result?
}

fn consent_memory_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, &'static str> {
    app.path().app_data_dir().map(|p| p.join("remote-consent-choices-v1.json"))
        .map_err(|_| "REMOTE_CONSENT_MEMORY_UNAVAILABLE")
}

/// Revocation only: no invoke path accepts a decision, scope, or remembered grant.
#[tauri::command]
pub async fn remote_control_clear_remembered_approvals(
    window: tauri::WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, RemoteControlState>,
) -> Result<(), &'static str> {
    require_main_window(window.label())?;
    let mut epoch = state.consent_memory_epoch.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
    consent_memory::Preferences::clear(&consent_memory_path(&app)?)?;
    *epoch = epoch.wrapping_add(1);
    Ok(())
}

/// Read-only metadata. No invoke command may create a remembered approval.
#[tauri::command]
pub async fn remote_control_list_remembered_approvals(
    window: tauri::WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, RemoteControlState>, user_id: u64,
) -> Result<Vec<consent_memory::RememberedApproval>, &'static str> {
    require_main_window(window.label())?;
    let path = consent_memory_path(&app)?;
    let epoch = state.consent_memory_epoch.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = identity::consent_verifying_key(&device_store::OsSeedStore, user_id)?;
        let _guard = epoch.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        Ok(consent_memory::Preferences::load(&path).list(user_id, &key))
    }).await.map_err(|_| "REMOTE_NATIVE_WORKER_FAILED")?
}

#[tauri::command]
pub async fn remote_control_remove_remembered_approval(
    window: tauri::WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, RemoteControlState>, user_id: u64, id: String,
) -> Result<(), &'static str> {
    require_main_window(window.label())?;
    if user_id == 0 || user_id > 9_007_199_254_740_991 || id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("REMOTE_CONSENT_RECORD_INVALID");
    }
    let path = consent_memory_path(&app)?;
    let mut epoch = state.consent_memory_epoch.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
    let mut preferences = consent_memory::Preferences::load(&path);
    if preferences.remove(user_id, &id) {
        preferences.save(&path)?;
        // An approval already in flight cannot reintroduce the deleted record.
        *epoch = epoch.wrapping_add(1);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct IdentityResetResult {
    reset: bool,
}

/// Rotating a registered key is never an automatic retry. This separate native
/// confirmation explicitly changes the OS identity; old server trust is not
/// inherited or silently revoked.
#[tauri::command]
pub async fn remote_control_reset_identity(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteControlState>,
    user_id: u64,
) -> Result<IdentityResetResult, &'static str> {
    require_main_window(window.label())?;
    let identity = state.identity.clone();
    let operation = identity
        .lock()
        .map_err(|_| "REMOTE_STATE_UNAVAILABLE")?
        .begin()?;
    let worker_state = identity.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(IdentityResetResult, identity::Operation), &'static str> {
        let previous = identity::identity_fingerprint(&device_store::OsSeedStore, user_id)?;
        worker_state.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?.check(operation)?;
        let decision = app.dialog().message(format!("账号：{user_id}\n当前设备公钥指纹：{previous}\n\n重建将替换本机该账号的设备私钥并清除本地协助授权。旧设备记录及撤销状态仍保留在服务端，新的身份需要重新登记和取得协助许可。"))
            .title("ToDesk · 重建设备身份")
            .buttons(MessageDialogButtons::YesNoCancelCustom("保留原身份".into(), "重建身份".into(), "取消".into()))
            .blocking_show_with_result();
        worker_state.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?.check(operation)?;
        if !matches!(decision, MessageDialogResult::Custom(ref label) if label == "重建身份") {
            return Ok((IdentityResetResult { reset: false }, operation));
        }
        // Fail closed before the first OS write: a write can succeed even when
        // its following confirmation read fails. The current reset alone gets
        // a replacement ticket; all previous local authority is destroyed.
        let native = app.state::<RemoteControlState>();
        let operation = worker_state.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?.invalidate_for_reset(operation)?;
        native.stop_host()?;
        identity::reset_identity(&device_store::OsSeedStore, user_id, &previous)?;
        worker_state.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?.check(operation)?;
        Ok((IdentityResetResult { reset: true }, operation))
    }).await.map_err(|_| "REMOTE_NATIVE_WORKER_FAILED").and_then(|result| result);
    let mut state = identity.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
    match result {
        Ok((result, completed)) => {
            state.finish(completed)?;
            Ok(result)
        }
        Err(error) => {
            state.release(operation);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn remote_control_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, RemoteControlState>,
) -> Result<(), &'static str> {
    require_main_window(window.label())?;
    state.stop()
}

fn require_main_window(label: &str) -> Result<(), &'static str> {
    if label == "main" {
        Ok(())
    } else {
        Err("REMOTE_CONTROL_WINDOW_NOT_ALLOWED")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_never_advertise_an_absent_engine() {
        let result = capabilities(false);
        assert_eq!(result.protocol_version, 1);
        assert!(!result.engine_ready);
        assert!(!result.can_capture);
        assert!(!result.can_inject_input);
        assert_eq!(result.platform, std::env::consts::OS);
        assert_eq!(result.arch, std::env::consts::ARCH);
        assert!(!result.os_version.is_empty());
    }

    #[test]
    fn secondary_windows_cannot_invoke_remote_control_commands() {
        assert!(require_main_window("main").is_ok());
        for label in ["", "remote", "approval", "main-2"] {
            assert!(require_main_window(label).is_err());
        }
    }

    #[test]
    fn repeated_local_stop_is_safe() {
        let state = RemoteControlState::default();
        state.stop().unwrap();
        state.stop().unwrap();
    }
}

/// Open only fixed OS permission pages after an explicit UI click. This never grants permission.
#[tauri::command]
pub async fn remote_control_open_permission_settings(
    window: tauri::WebviewWindow,
    permission: String,
) -> Result<(), &'static str> {
    require_main_window(window.label())?;
    if std::env::consts::OS != "macos" { return Err("PLATFORM_UNSUPPORTED"); }
    let url = match permission.as_str() {
        "screenCapture" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "inputControl" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        _ => return Err("INVALID_PERMISSION"),
    };
    let status = std::process::Command::new("/usr/bin/open").arg(url).status().map_err(|_| "SETTINGS_UNAVAILABLE")?;
    if status.success() { Ok(()) } else { Err("SETTINGS_UNAVAILABLE") }
}
