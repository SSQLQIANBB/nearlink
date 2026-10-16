use serde::Serialize;

#[derive(Serialize)]
pub struct ReleaseInfo {
    platform: Option<&'static str>,
    version: &'static str,
}

#[tauri::command]
pub fn desktop_release_info() -> ReleaseInfo {
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-x64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        _ => None,
    };
    ReleaseInfo {
        platform,
        version: env!("CARGO_PKG_VERSION"),
    }
}

fn download_url(version: &str, platform: &str) -> Result<String, String> {
    let (base, alpha) = version.split_once("-alpha.").ok_or("Invalid version")?;
    let components: Vec<_> = base.split('.').collect();
    let numeric = |value: &str| {
        !value.is_empty()
            && value.len() <= 10
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0'))
    };
    if components.len() != 3 || !components.iter().all(|value| numeric(value)) || !numeric(alpha) {
        return Err("Invalid version".into());
    }
    let suffix = match platform {
        "windows-x64" => "x64-setup.exe",
        "macos-arm64" => "aarch64.dmg",
        "macos-x64" => "x64.dmg",
        _ => return Err("Unsupported platform".into()),
    };
    Ok(format!("https://github.com/SSQLQIANBB/nearlink/releases/download/desktop-v{version}/NearLink_{version}_{suffix}"))
}

// Only fixed-repository installer URLs; no arbitrary URL or shell command from the WebView.
#[tauri::command]
pub fn desktop_release_download(
    version: String,
    platform: String,
    resource: Option<String>,
) -> Result<(), String> {
    let installer = download_url(&version, &platform)?;
    let url = match resource.as_deref() {
        None => installer,
        Some("notes") => {
            format!("https://github.com/SSQLQIANBB/nearlink/releases/tag/desktop-v{version}")
        }
        _ => return Err("Unsupported release resource".into()),
    };
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("/usr/bin/open")
        .arg(&url)
        .status();
    #[cfg(target_os = "windows")]
    let status = {
        let root = std::env::var_os("SystemRoot").ok_or("Missing system directory")?;
        std::process::Command::new(std::path::PathBuf::from(root).join("System32/rundll32.exe"))
            .args(["url.dll,FileProtocolHandler", &url])
            .status()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = url;
        return Err("Unsupported platform".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if status.map_err(|_| "无法打开系统浏览器")?.success() {
        Ok(())
    } else {
        Err("无法打开系统浏览器".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_downloads_to_installer_paths() {
        assert!(download_url("0.12.0-alpha.1", "windows-x64")
            .unwrap()
            .ends_with("NearLink_0.12.0-alpha.1_x64-setup.exe"));
        for version in [
            "../evil",
            "0.12.0-alpha.1&calc",
            "00.12.0-alpha.1",
            "0.12.0",
        ] {
            assert!(download_url(version, "windows-x64").is_err());
        }
        assert!(download_url("0.12.0-alpha.1", "https://evil.example").is_err());
    }
}
