//! Shared by build.rs and the native loader. A compiled manifest pins every
//! executable, script, plugin and library in the closed resource tree.
#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub const FORMAT: &str = "todesk-engine-bundle-v1";
pub const RESOURCE_DIRECTORY: &str = "remote-control-engine";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub executable: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleManifest {
    pub format: String,
    pub target: String,
    pub entrypoint: String,
    pub files: Vec<BundleFile>,
}
pub struct VerifiedTree {
    #[cfg(windows)]
    pub locks: Vec<File>,
    pub root: PathBuf,
    pub entrypoint: PathBuf,
    pub manifest: BundleManifest,
    pub digest: String,
}
fn fail(message: &str) -> String {
    format!("REMOTE_ENGINE_BUNDLE: {message}")
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(|c| c.is_control())
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && part.len() <= 255)
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
pub fn parse(bytes: &[u8], target: &str) -> Result<BundleManifest> {
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(fail("manifest too large"));
    }
    let manifest: BundleManifest =
        serde_json::from_slice(bytes).map_err(|_| fail("invalid manifest"))?;
    if manifest.format != FORMAT
        || manifest.target != target
        || !matches!(target, "aarch64-apple-darwin" | "x86_64-pc-windows-msvc")
        || manifest.entrypoint != (if target == "x86_64-pc-windows-msvc" { "bin/remote-control-engine.exe" } else { "bin/remote-control-engine" })
        || manifest.files.is_empty()
        || manifest.files.len() > MAX_FILES
    {
        return Err(fail("unsupported bundle"));
    }
    let mut total = 0u64;
    let mut previous: Option<&str> = None;
    let mut entrypoint = false;
    for file in &manifest.files {
        if !relative_path(&file.path)
            || file.path == MANIFEST_FILE
            || previous.is_some_and(|old| old >= file.path.as_str())
            || file.size > MAX_FILE_BYTES
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(fail("invalid file declaration"));
        }
        previous = Some(&file.path);
        total = total
            .checked_add(file.size)
            .filter(|total| *total <= MAX_BUNDLE_BYTES)
            .ok_or_else(|| fail("bundle too large"))?;
        if file.path == manifest.entrypoint {
            entrypoint = file.executable;
        }
    }
    if !entrypoint {
        return Err(fail("missing executable entrypoint"));
    }
    Ok(manifest)
}
fn read_bounded(file: &mut File, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail("file unreadable"))?;
    if bytes.len() as u64 > limit {
        return Err(fail("file too large"));
    }
    Ok(bytes)
}

#[cfg(unix)]
mod anchored {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };
    pub fn root(path: &Path) -> Result<File> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| fail("root must be a real directory"))?;
        if file
            .metadata()
            .map_err(|_| fail("root unavailable"))?
            .mode()
            & 0o022
            != 0
        {
            return Err(fail("writable resource directory"));
        }
        Ok(file)
    }
    pub fn child(parent: &File, name: &str) -> Result<File> {
        let name = CString::new(name).map_err(|_| fail("invalid resource name"))?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(fail("resource missing, unreadable or symlinked"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn names(directory: &File) -> Result<Vec<String>> {
        let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
        if duplicate < 0 {
            return Err(fail("directory unavailable"));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            unsafe { libc::close(duplicate) };
            return Err(fail("directory unreadable"));
        }
        struct Dir(*mut libc::DIR);
        impl Drop for Dir {
            fn drop(&mut self) {
                unsafe { libc::closedir(self.0) };
            }
        }
        let owner = Dir(stream);
        let mut names = Vec::new();
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(owner.0) };
            if entry.is_null() {
                if std::io::Error::last_os_error()
                    .raw_os_error()
                    .is_some_and(|errno| errno != 0)
                {
                    return Err(fail("directory enumeration failed"));
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = std::str::from_utf8(bytes).map_err(|_| fail("non-UTF8 resource path"))?;
            if !relative_path(name) || name.contains('/') {
                return Err(fail("invalid resource path"));
            }
            names.push(name.to_owned());
            if names.len() > MAX_FILES * 2 {
                return Err(fail("too many resources"));
            }
        }
        names.sort();
        Ok(names)
    }
    pub fn check_regular(file: &File, executable: bool) -> Result<std::fs::Metadata> {
        let metadata = file.metadata().map_err(|_| fail("resource unavailable"))?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o022 != 0
            || (metadata.mode() & 0o111 != 0) != executable
        {
            return Err(fail("resource type, link or permissions rejected"));
        }
        Ok(metadata)
    }
    pub fn check_directory(file: &File) -> Result<()> {
        let metadata = file.metadata().map_err(|_| fail("directory unavailable"))?;
        if !metadata.is_dir() || metadata.mode() & 0o022 != 0 {
            return Err(fail("directory type or permissions rejected"));
        }
        Ok(())
    }
    pub fn same_root(file: &File, path: &Path) -> Result<()> {
        let before = file.metadata().map_err(|_| fail("root unavailable"))?;
        let after = std::fs::metadata(path).map_err(|_| fail("root changed"))?;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(fail("root changed"));
        }
        Ok(())
    }
}

#[cfg(unix)]
pub fn read_manifest(root: &Path) -> Result<Vec<u8>> {
    let directory = anchored::root(root)?;
    let mut file = anchored::child(&directory, MANIFEST_FILE)?;
    anchored::check_regular(&file, false)?;
    read_bounded(&mut file, MAX_MANIFEST_BYTES)
}
#[cfg(not(any(unix, windows)))]
pub fn read_manifest(_root: &Path) -> Result<Vec<u8>> {
    Err(fail("bundle platform unsupported"))
}

#[cfg(unix)]
pub fn verify(root: &Path, expected: &[u8], target: &str) -> Result<VerifiedTree> {
    let manifest = parse(expected, target)?;
    let directory = anchored::root(root)?;
    let canonical = root.canonicalize().map_err(|_| fail("root unavailable"))?;
    anchored::same_root(&directory, &canonical)?;
    let mut manifest_file = anchored::child(&directory, MANIFEST_FILE)?;
    anchored::check_regular(&manifest_file, false)?;
    if read_bounded(&mut manifest_file, MAX_MANIFEST_BYTES)? != expected {
        return Err(fail("manifest differs from compiled trust anchor"));
    }
    let files: BTreeMap<&str, &BundleFile> = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut directories = BTreeSet::new();
    for file in &manifest.files {
        let mut path = Path::new(&file.path).parent();
        while let Some(parent) = path {
            if !parent.as_os_str().is_empty() {
                directories.insert(parent.to_str().unwrap().to_owned());
            }
            path = parent.parent();
        }
    }
    fn walk(
        directory: &File,
        prefix: &str,
        files: &BTreeMap<&str, &BundleFile>,
        directories: &BTreeSet<String>,
        seen: &mut BTreeSet<String>,
        depth: usize,
    ) -> Result<()> {
        if depth > 32 {
            return Err(fail("resource nesting too deep"));
        }
        for name in anchored::names(directory)? {
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let mut file = anchored::child(directory, &name)?;
            let metadata = file.metadata().map_err(|_| fail("resource unavailable"))?;
            if metadata.is_dir() {
                anchored::check_directory(&file)?;
                if !directories.contains(&relative) {
                    return Err(fail("unlisted resource directory"));
                }
                walk(&file, &relative, files, directories, seen, depth + 1)?;
            } else {
                if relative == MANIFEST_FILE {
                    continue;
                }
                let spec = files
                    .get(relative.as_str())
                    .ok_or_else(|| fail("unlisted resource file"))?;
                let metadata = anchored::check_regular(&file, spec.executable)?;
                if metadata.len() != spec.size {
                    return Err(fail(&format!("resource size mismatch: {relative}")));
                }
                let mut digest = Sha256::new();
                let mut total = 0u64;
                let mut buffer = [0u8; 65536];
                loop {
                    let read = file
                        .read(&mut buffer)
                        .map_err(|_| fail("resource unreadable"))?;
                    if read == 0 {
                        break;
                    }
                    total += read as u64;
                    if total > spec.size {
                        return Err(fail("resource changed while reading"));
                    }
                    digest.update(&buffer[..read]);
                }
                if total != spec.size || format!("{:x}", digest.finalize()) != spec.sha256 {
                    return Err(fail(&format!("resource hash mismatch: {relative}")));
                }
                seen.insert(relative);
            }
        }
        Ok(())
    }
    let mut seen = BTreeSet::new();
    walk(&directory, "", &files, &directories, &mut seen, 0)?;
    if seen.len() != files.len() {
        return Err(fail("resource missing"));
    }
    anchored::same_root(&directory, &canonical)?;
    Ok(VerifiedTree {
        entrypoint: canonical.join(&manifest.entrypoint),
        root: canonical,
        manifest,
        digest: sha256(expected),
    })
}
#[cfg(not(any(unix, windows)))]
pub fn verify(_root: &Path, _expected: &[u8], _target: &str) -> Result<VerifiedTree> {
    Err(fail("bundle platform unsupported"))
}

#[cfg(windows)]
#[path = "windows_engine_bundle.rs"]
mod windows_bundle;
#[cfg(windows)]
pub use windows_bundle::{read_manifest, verify};

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Fixture {
        root: PathBuf,
        bytes: Vec<u8>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "todesk-bundle-unit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("bin")).unwrap();
        fs::create_dir(root.join("lib")).unwrap();
        let mut files = Vec::new();
        for (path, bytes, executable) in [
            (
                "bin/remote-control-engine",
                b"fixed-launcher".as_slice(),
                true,
            ),
            ("lib/entry.py", b"fixed-script".as_slice(), false),
            ("lib/runtime.dylib", b"fixed-library".as_slice(), true),
        ] {
            fs::write(root.join(path), bytes).unwrap();
            fs::set_permissions(
                root.join(path),
                fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
            )
            .unwrap();
            files.push(BundleFile {
                path: path.into(),
                size: bytes.len() as u64,
                sha256: sha256(bytes),
                executable,
            });
        }
        let bytes = serde_json::to_vec(&BundleManifest {
            format: FORMAT.into(),
            target: "aarch64-apple-darwin".into(),
            entrypoint: "bin/remote-control-engine".into(),
            files,
        })
        .unwrap();
        fs::write(root.join(MANIFEST_FILE), &bytes).unwrap();
        Fixture { root, bytes }
    }
    #[test]
    fn entire_closed_tree_and_manifest_match_the_build_trust_anchor() {
        let f = fixture();
        let verified = verify(&f.root, &f.bytes, "aarch64-apple-darwin").unwrap();
        assert_eq!(verified.manifest.files.len(), 3);
        assert_eq!(verified.digest, sha256(&f.bytes));
        assert_eq!(
            verified.entrypoint,
            verified.root.join("bin/remote-control-engine")
        );
        assert_eq!(read_manifest(&f.root).unwrap(), f.bytes);
    }
    #[test]
    fn script_or_library_tampering_is_rejected_even_when_launcher_is_unchanged() {
        for file in ["lib/entry.py", "lib/runtime.dylib"] {
            let f = fixture();
            let path = f.root.join(file);
            let mut bytes = fs::read(&path).unwrap();
            bytes[0] ^= 1;
            fs::write(path, bytes).unwrap();
            assert!(verify(&f.root, &f.bytes, "aarch64-apple-darwin").is_err());
        }
    }
    #[test]
    fn missing_extra_or_mutated_manifests_and_empty_directories_are_rejected() {
        for mode in 0..4 {
            let f = fixture();
            match mode {
                0 => fs::remove_file(f.root.join("lib/entry.py")).unwrap(),
                1 => fs::write(f.root.join("lib/usercustomize.py"), b"unlisted").unwrap(),
                2 => {
                    let mut bytes = f.bytes.clone();
                    bytes.push(b' ');
                    fs::write(f.root.join(MANIFEST_FILE), bytes).unwrap();
                }
                _ => fs::create_dir(f.root.join("extra")).unwrap(),
            }
            assert!(verify(&f.root, &f.bytes, "aarch64-apple-darwin").is_err());
        }
    }
    #[test]
    fn symlink_file_directory_root_and_hardlink_aliases_are_rejected() {
        for mode in 0..4 {
            let f = fixture();
            let outside = fixture();
            match mode {
                0 => {
                    fs::remove_file(f.root.join("lib/entry.py")).unwrap();
                    symlink(
                        outside.root.join("lib/entry.py"),
                        f.root.join("lib/entry.py"),
                    )
                    .unwrap();
                }
                1 => {
                    fs::remove_dir_all(f.root.join("lib")).unwrap();
                    symlink(outside.root.join("lib"), f.root.join("lib")).unwrap();
                }
                2 => {
                    let link = f.root.join("root-link");
                    symlink(&outside.root, &link).unwrap();
                    assert!(verify(&link, &outside.bytes, "aarch64-apple-darwin").is_err());
                    continue;
                }
                _ => {
                    fs::remove_file(f.root.join("lib/entry.py")).unwrap();
                    fs::hard_link(
                        outside.root.join("lib/entry.py"),
                        f.root.join("lib/entry.py"),
                    )
                    .unwrap();
                }
            }
            assert!(verify(&f.root, &f.bytes, "aarch64-apple-darwin").is_err());
        }
    }
    #[test]
    fn permissions_executable_modes_and_target_must_match() {
        for (path, mode) in [
            ("bin/remote-control-engine", 0o644),
            ("lib/entry.py", 0o755),
            ("lib/entry.py", 0o666),
            ("lib", 0o777),
        ] {
            let f = fixture();
            fs::set_permissions(f.root.join(path), fs::Permissions::from_mode(mode)).unwrap();
            assert!(verify(&f.root, &f.bytes, "aarch64-apple-darwin").is_err());
        }
        let f = fixture();
        assert!(verify(&f.root, &f.bytes, "x86_64-apple-darwin").is_err());
    }
    #[test]
    fn unsafe_or_duplicate_manifest_paths_and_unknown_fields_are_rejected() {
        let f = fixture();
        for path in [
            "../outside",
            "/absolute",
            "lib/../file",
            "lib//file",
            "lib\\file",
            "lib/./file",
            "C:/file",
            "lib/file\n",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&f.bytes).unwrap();
            value["files"][1]["path"] = path.into();
            assert!(parse(&serde_json::to_vec(&value).unwrap(), "aarch64-apple-darwin").is_err());
        }
        for mode in 0..4 {
            let mut value: serde_json::Value = serde_json::from_slice(&f.bytes).unwrap();
            match mode {
                0 => value["extra"] = true.into(),
                1 => value["files"][0]["extra"] = true.into(),
                2 => value["files"][1] = value["files"][0].clone(),
                _ => value["files"][1]["size"] = (MAX_FILE_BYTES + 1).into(),
            }
            assert!(parse(&serde_json::to_vec(&value).unwrap(), "aarch64-apple-darwin").is_err());
        }
    }
}
