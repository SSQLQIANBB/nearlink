//! Non-interactive probes only. Never request TCC permission or post input here.

#[allow(dead_code)] // The states used by each OS differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionState {
    Granted,
    Denied,
    Unknown,
    Unsupported,
}

impl PermissionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Unknown => "unknown",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug)]
pub struct PlatformProbe {
    pub platform: &'static str,
    pub os_version: String,
    pub arch: &'static str,
    pub candidate_platform: bool,
    pub screen_capture: PermissionState,
    pub input_control: PermissionState,
}

pub fn probe() -> PlatformProbe {
    let (os_version, candidate_platform) = platform_probe();
    let (screen_capture, input_control) = permissions();
    PlatformProbe {
        platform: std::env::consts::OS,
        os_version,
        arch: std::env::consts::ARCH,
        candidate_platform,
        screen_capture,
        input_control,
    }
}

/// Query only the current permissions, without prompts, OS input or subprocesses.
/// This path is safe to use from the independent watchdog and event handlers.
#[cfg(target_os = "macos")]
pub fn permissions() -> (PermissionState, PermissionState) {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }
    // `denied` includes not-yet-granted; TCC does not expose the distinction
    // through these read-only preflight APIs.
    let state = |granted| {
        if granted {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        }
    };
    (
        state(unsafe { CGPreflightScreenCaptureAccess() }),
        state(unsafe { AXIsProcessTrusted() } != 0),
    )
}

#[cfg(target_os = "windows")]
pub(super) fn interactive_desktop() -> bool {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
        fn GetUserObjectInformationW(object: *mut c_void, index: i32, info: *mut c_void, length: u32, needed: *mut u32) -> i32;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
    }
    let desktop = unsafe { OpenInputDesktop(0, 0, 1 /* DESKTOP_READOBJECTS */) };
    if desktop.is_null() { return false; }
    let mut name = [0u16; 64];
    let mut required = 0;
    let read = unsafe { GetUserObjectInformationW(desktop, 2 /* UOI_NAME */, name.as_mut_ptr().cast(), std::mem::size_of_val(&name) as u32, &mut required) };
    unsafe { CloseDesktop(desktop) };
    let end = name.iter().position(|v| *v == 0).unwrap_or(name.len());
    read != 0 && String::from_utf16_lossy(&name[..end]) == "Default"
}

#[cfg(target_os = "windows")]
pub fn permissions() -> (PermissionState, PermissionState) {
    // Windows has no TCC grant: access is limited to the interactive desktop.
    // Capture progress and SendInput/UIPI failures are still enforced at runtime.
    let access = if interactive_desktop() { PermissionState::Granted } else { PermissionState::Denied };
    (access, access)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn permissions() -> (PermissionState, PermissionState) {
    (PermissionState::Unsupported, PermissionState::Unsupported)
}

#[cfg(target_os = "macos")]
fn platform_probe() -> (String, bool) {
    let os_version = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_owned());
    let candidate_platform = os_version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 13);
    (os_version, candidate_platform)
}

#[cfg(target_os = "windows")]
fn platform_probe() -> (String, bool) {
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform_id: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }
    let mut info = OsVersionInfo {
        size: std::mem::size_of::<OsVersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform_id: 0,
        service_pack: [0; 128],
    };
    let (version, candidate) = if unsafe { RtlGetVersion(&mut info) } >= 0 {
        (
            format!("{}.{}.{}", info.major, info.minor, info.build),
            info.major >= 10 && info.build >= 22000 && std::env::consts::ARCH == "x86_64",
        )
    } else {
        ("unknown".to_owned(), false)
    };
    (version, candidate)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_probe() -> (String, bool) {
    let version = std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|| "unknown".to_owned());
    (version, false)
}
